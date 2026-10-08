export type MailStatus = "queued"|"sending"|"sent"|"failed";
export interface SendMailRequest {from:string;to:string[];subject:string;text?:string;html?:string;reply_to?:string;headers?:Record<string,string>;idempotency_key?:string;}
export interface MailRecord {id:string;from_address:string;to_addresses:string[];subject:string;text_body:string|null;html_body:string|null;reply_to:string|null;headers_json:Record<string,string>;idempotency_key:string|null;status:MailStatus;attempts:number;last_error:string|null;created_at:string;updated_at:string;sent_at:string|null;}
