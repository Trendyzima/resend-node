export type MailStatus = "queued" | "sending" | "sent" | "failed";
export interface SendMailRequest { from: string; to: string[]; subject: string; text?: string; html?: string; reply_to?: string; headers?: Record<string,string>; idempotency_key?: string; }
export interface MailRecord extends SendMailRequest { id:string; status:MailStatus; attempts:number; last_error:string|null; created_at:string; sent_at:string|null; }
