import "websocket-polyfill";
import crypto from "crypto";
import { webln } from "alby-js-sdk";
import { LightningAddress } from "alby-tools";
import { Inngest } from "inngest";
import { serve } from "inngest/next";
import { WebLNProvider } from "@webbtc/webln-types";
import { NostrProvider } from "alby-tools/dist/types";
import { signEvent, getPublicKey, getEventHash } from "nostr-tools";

global.crypto = crypto;

type PeriodicZapEvent = {
  name: "zap";
  data: {
    lightningAddress: string;
    amount: number;
    message?: string;
  };
  user: {
    nostrWalletConnectUrl: string;
  };
};
type Events = {
  zap: PeriodicZapEvent;
};

export const inngest = new Inngest<Events>({ name: "NWC Periodic Payments" });

const DEFAULT_ZAP_RELAYS = ["wss://relay.damus.io"];

const periodicZap = inngest.createFunction(
  { name: "Periodic Zap" },
  { event: "zap" },
  async ({ event, step }) => {
    console.log("Sleep start");
    await step.sleep("1s");
    console.log("Sleep end");

    const { lightningAddress, amount, message } = event.data;
    const { nostrWalletConnectUrl } = event.user;
    const noswebln = new webln.NostrWebLNProvider({
      relayUrl: "wss://nostr.bitcoiner.social",
      nostrWalletConnectUrl,
    });
    const privateKey = nostrWalletConnectUrl
      .toLowerCase()
      .match(/secret=[a-f0-9]+/)?.[0]
      .substring("secret=".length);
    if (!privateKey || privateKey.length !== 64) {
      throw new Error("nostrWalletConnectUrl does not contain a valid secret");
    }
    const pubkey = getPublicKey(privateKey);

    // FIXME: noswebln does not fully implement WebLNProvider
    const ln = new LightningAddress(lightningAddress, {
      webln: noswebln as unknown as WebLNProvider,
    });
    await ln.fetch();

    const nostr: NostrProvider = {
      getPublicKey: () => Promise.resolve(pubkey),
      signEvent: (event) => {
        const signedEvent = {
          ...event,
          pubkey,
        };

        signedEvent.id = getEventHash(signedEvent);
        signedEvent.sig = signEvent(signedEvent, privateKey);
        console.error("Signed event: " + event.kind);
        return Promise.resolve(signedEvent);
      },
    };

    console.log("Zapping...");
    const response = await ln.zap(
      {
        satoshi: amount,
        comment: message,
        relays: DEFAULT_ZAP_RELAYS,
      },
      {
        nostr,
      }
    );
    console.error("Zap done", response, event);

    // TODO: sleep the specified amount of time
    // FIXME: for some reason sleeping here freezes the process
    // TODO: call the function again if the subscription is still enabled
    return { event, body: response.preimage };
  }
);

export default serve(inngest, [periodicZap]);