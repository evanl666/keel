# Webhook signing

Outgoing webhooks are signed with HMAC-SHA256 over the raw body. The signing secret lives in the
secrets service under `payments/webhook-signing`. Rotate it every 90 days: create the new secret,
dual-sign for 24 hours, then retire the old one. Owner: Payments on-call.
