export const config={
  host:process.env.MAIL_HOST??"127.0.0.1",
  port:Number(process.env.MAIL_PORT??8787),
  apiKey:process.env.MAIL_API_KEY??"",
  smtpHost:process.env.SMTP_HOST??"127.0.0.1",
  smtpPort:Number(process.env.SMTP_PORT??25),
  smtpUser:process.env.SMTP_USER??"",
  smtpPass:process.env.SMTP_PASS??"",
  from:process.env.MAIL_FROM??"no-reply@testagram.site",
  queueDir:process.env.MAIL_QUEUE_DIR??"/var/lib/testagram-mail/queue",
  supabaseUrl:process.env.SUPABASE_URL??"",
  supabaseKey:process.env.SUPABASE_SECRET_KEY??process.env.SUPABASE_SERVICE_ROLE_KEY??"",
  maxAttempts:Number(process.env.MAIL_MAX_ATTEMPTS??5)
} as const;
