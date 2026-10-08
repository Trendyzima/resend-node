function required(name:string){const v=process.env[name]?.trim();if(!v)throw new Error("MISSING_"+name);return v;}
export const config={
 host:process.env.MAIL_HOST??"127.0.0.1", port:Number(process.env.MAIL_PORT??8787),
 apiKey:required("MAIL_API_KEY"),
 supabaseUrl:required("SUPABASE_URL").replace(/\\/$/,""),
 supabaseServiceKey:required("SUPABASE_SERVICE_KEY"),
 heloName:process.env.MAIL_HELO_NAME??"mail.testagram.site",
 mailDomain:process.env.MAIL_DOMAIN??"testagram.site",
 dkimSelector:process.env.DKIM_SELECTOR??"mail",
 dkimPrivateKey:process.env.DKIM_PRIVATE_KEY??"",
 smtpTimeoutMs:Number(process.env.SMTP_TIMEOUT_MS??20000),
 workerIntervalMs:Number(process.env.MAIL_WORKER_INTERVAL_MS??1000),
 maxAttempts:Number(process.env.MAIL_MAX_ATTEMPTS??8),
 retryBaseMs:Number(process.env.MAIL_RETRY_BASE_MS??5000),
} as const;
