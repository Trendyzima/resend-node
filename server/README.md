# Testagram Mail

A first-party transactional email service inspired by the useful client/API concepts in the reference repository, but with no Resend runtime dependency.

Flow: authenticated HTTP API -> durable local spool -> SMTP/Postfix -> recipient.

Core API: GET /health and POST /emails. POST requires Bearer authentication, supports Idempotency-Key, bounds requests to 1 MiB, and returns 202 after durable queueing.

Production should run the API and worker as separate systemd services, behind TLS, with Postfix bound to localhost/private networking. SPF, DKIM and DMARC are mail-infrastructure requirements and must be configured before production sending.