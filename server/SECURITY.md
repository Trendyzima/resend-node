# Security

- Keep MAIL_API_KEY server-side; never ship it to browser code.
- Bind the API to loopback/private networking and expose only HTTPS through a hardened reverse proxy.
- Keep SMTP on localhost/private networking.
- Use a dedicated Unix service account and the supplied systemd sandboxing directives.
- Configure SPF, DKIM and DMARC for testagram.site before production mail.
- Treat inbound webhooks and delivery feedback as untrusted input and verify signatures before processing.
- Do not put passwords, OTPs, identity documents or KYC evidence into email logs.
