import {
  createResendWebhookProcessorFromEnv,
  readResendWebhookHeaders,
  type ResendWebhookProcessor,
} from "../../packages/mail/src/index.js";

let processor: ResendWebhookProcessor | undefined;

function getProcessor(): ResendWebhookProcessor {
  processor ??= createResendWebhookProcessorFromEnv(process.env);
  return processor;
}

export async function handleResendWebhook(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }

  try {
    const rawBody = await request.text();
    const event = await getProcessor().process(rawBody, readResendWebhookHeaders(request.headers));
    if (event) {
      console.info("mail_homologation_webhook", JSON.stringify(event));
    }
    return Response.json({ received: true });
  } catch {
    return Response.json({ received: false }, { status: 400 });
  }
}

export default {
  fetch: handleResendWebhook,
};
