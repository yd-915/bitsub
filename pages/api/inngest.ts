import crypto from "crypto";
import { webln } from "@getalby/sdk";
import { LightningAddress } from "@getalby/lightning-tools";
import { EventSchemas, Inngest } from "inngest";
import { serve } from "inngest/next";
import { prismaClient } from "lib/server/prisma";
import { MAX_RETRIES } from "lib/constants";
import { logger } from "lib/server/logger";
import { areEmailNotificationsSupported } from "lib/server/areEmailNotificationsSupported";
import { sendEmail } from "lib/server/sendEmail";
import { isError } from "lib/utils";
import { add } from "date-fns";
import ms from "ms";

global.crypto = crypto;

type PeriodicZapEvent = {
  name: "zap";
  data: {
    subscriptionId: string;
  };
};
type CancelSubscriptionEvent = {
  name: "cancel";
  data: {
    subscriptionId: string;
  };
};

type Events = {
  zap: PeriodicZapEvent;
  cancel: CancelSubscriptionEvent;
};

type NWCPaymentError = {
  error: string;
  code: string;
};

export const inngest = new Inngest({
  name: "NWC Periodic Payments",
  schemas: new EventSchemas().fromRecord<Events>(),
});

const ENABLE_REPEAT_EVENTS = true;

const periodicZap = inngest.createFunction(
  {
    name: "Periodic Zap",
    cancelOn: [
      {
        event: "cancel",
        match: "data.subscriptionId",
      },
    ],
  },
  { event: "zap" },
  async ({ event, step }) => {
    const sleepDuration = await step.run("Send payment", async () => {
      const { subscriptionId } = event.data;
      const subscription = await prismaClient.subscription.findUnique({
        where: {
          id: subscriptionId,
        },
      });
      if (!subscription) {
        logger.info("No subscription found. Cancelling zap", {
          subscriptionId,
        });
        return undefined;
      }
      // safety check in case inngest fires unexpected event
      if (subscription.retryCount >= MAX_RETRIES) {
        logger.error("Subscription retry count exceeded. Skipping", {
          subscriptionId,
        });
        return undefined;
      }
      // safety check in case inngest fires unexpected event
      if (subscription.lastEventDateTime) {
        const expectedNextEvent = add(subscription.lastEventDateTime, {
          seconds: ms(subscription.sleepDuration) / 1000,
        });

        if (Date.now() < expectedNextEvent.getTime()) {
          logger.error("Subscription event requested too early. Skipping", {
            subscriptionId,
            expectedDateTime: expectedNextEvent.toISOString(),
            currentDateTime: new Date().toISOString(),
            diffSeconds: Math.floor(
              (expectedNextEvent.getTime() - Date.now()) / 1000,
            ),
          });
          return undefined;
        }
      }
      await prismaClient.subscription.update({
        where: {
          id: subscription.id,
        },
        data: {
          lastEventDateTime: new Date(),
        },
      });

      const { nostrWalletConnectUrl, recipientLightningAddress, amount } =
        subscription;
      const message = subscription.message ?? undefined;

      let paymentSucceeded = false;
      let paymentRecovered = false;
      let errorMessage = "";
      try {
        const noswebln = new webln.NostrWebLNProvider({
          nostrWalletConnectUrl,
        });

        // FIXME: noswebln does not fully implement WebLNProvider
        const ln = new LightningAddress(recipientLightningAddress, {
          webln: noswebln,
        });
        await ln.fetch();

        if (!ln.lnurlpData) {
          throw new Error(
            "Failed to retrieve LNURLp data for " + recipientLightningAddress,
          );
        }

        logger.info("Enabling noswebln", { subscriptionId });
        await noswebln.enable();
        logger.info("Requesting invoice", { subscriptionId });
        const invoice = await ln.requestInvoice({
          satoshi: amount,
          comment:
            message &&
            ln.lnurlpData.commentAllowed &&
            ln.lnurlpData.commentAllowed >= message.length
              ? message
              : undefined,
          // TODO: only send supported payerData?
          payerdata:
            ln.lnurlpData.payerData && subscription.payerData
              ? JSON.parse(subscription.payerData)
              : undefined,
        });
        logger.info("Sending payment", { subscriptionId });
        const response = (await noswebln.sendPayment(
          invoice.paymentRequest,
        )) as { preimage: string };
        if (response.preimage) {
          logger.info("Payment sent successfully", {
            response,
            subscriptionId,
          });
        } else {
          logger.error("Payment sent but no preimage in response", {
            response,
            subscriptionId,
          });
          throw new Error("Payment sent but no preimage in response");
        }

        if (subscription.retryCount > 0) {
          paymentRecovered = true;
        }
        paymentSucceeded = true;
        try {
          noswebln.close();
        } catch (error) {
          logger.error("Failed to close noswebln", { subscriptionId });
        }
      } catch (error) {
        try {
          if (isError(error)) {
          } else {
           
          }
        } catch (error) {
          console.error("Failed to capture error", error);
        }
        logger.error("Failed to send periodic zap", {
          subscriptionId,
          error,
          noSuccessfulPayments: subscription.numSuccessfulPayments === 0,
        });
        if (typeof error === "string") {
          errorMessage = error;
        } else if (
          (error as NWCPaymentError).error &&
          typeof (error as NWCPaymentError).error === "string"
        ) {
          errorMessage = (
            ((error as NWCPaymentError).code || "") +
            " " +
            (error as NWCPaymentError).error
          ).trim();
        } else if ((error as Error).message) {
          errorMessage = (error as Error).message;
        } else {
          logger.error("Unparsable error", { error });
          errorMessage = "Unknown";
        }
      }
      const updatedSubscription = await prismaClient.subscription.update({
        where: {
          id: subscriptionId,
        },
        data: {
          retryCount: paymentSucceeded ? 0 : subscription.retryCount + 1,
          lastSuccessfulPaymentDateTime: paymentSucceeded
            ? new Date()
            : undefined,
          lastFailedPaymentDateTime: !paymentSucceeded ? new Date() : undefined,
          numFailedPayments:
            subscription.numFailedPayments + (paymentSucceeded ? 0 : 1),
          numSuccessfulPayments:
            subscription.numSuccessfulPayments + (paymentSucceeded ? 1 : 0),
        },
      });

      if (
        areEmailNotificationsSupported(updatedSubscription.sleepDuration) &&
        updatedSubscription.email &&
        updatedSubscription.sendPaymentNotifications
      ) {
        if (paymentRecovered) {
          await sendEmail(updatedSubscription.email, {
            type: "payment-recovered",
            subscription: updatedSubscription,
            numRetries: subscription.retryCount,
          });
        }

        await sendEmail(updatedSubscription.email, {
          type: paymentSucceeded ? "payment-success" : "payment-failed",
          subscription: updatedSubscription,
          errorMessage,
        });
      }

      if (updatedSubscription.retryCount >= MAX_RETRIES) {
        logger.error("subscription payment failed too many times", {
          subscriptionId,
        });
        if (subscription.email) {
          await sendEmail(subscription.email, {
            type: "subscription-deactivated",
            subscription,
          });
        }
        return undefined;
      }

      logger.info(`Sleeping for ${subscription.sleepDuration}`, {
        subscriptionId,
      });
      return subscription.sleepDuration;
    });

    if (!sleepDuration) {
      logger.info(`Not rescheduling a new event`, {
        subscriptionId: event.data.subscriptionId,
      });
      return;
    }

    await step.sleep(sleepDuration);

    if (ENABLE_REPEAT_EVENTS) {
      // create a new event object without inngest-added properties (id, ts)
      const newEvent: typeof event = { data: event.data, name: event.name };
      try {
        await step.sendEvent(newEvent);
      } catch (error) {
        logger.error("Failed to reschedule event", {
          error,
          subscriptionId: event.data.subscriptionId,
        });
        throw error;
      }
    }

    return { event, body: "OK" };
  },
);

export default serve(inngest, [periodicZap]);
