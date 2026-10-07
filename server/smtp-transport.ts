import net from "node:net";
import tls from "node:tls";

type Options={host:string;port:number;username:string;password:string;secure:boolean;from:string};
type Mail={id:string;from:string;to:string[];subject:string;text:string;html:string};

export class SMTPTransport{
 readonly from:string;
 constructor(private readonly o:Options){this.from=o.from;}
 async send(mail:Mail):Promise<void>{
  if(!this.o.host||!this.o.username||!this.o.password)throw new Error("SMTP_NOT_CONFIGURED");
  const socket=this.o.secure?tls.connect({host:this.o.host,port:this.o.port,servername:this.o.host}):net.connect({host:this.o.host,port:this.o.port});
  let active:net.Socket|tls.TLSSocket=socket;
  const read=()=>new Promise<string>((resolve,reject)=>{let data="";const onData=(b:Buffer)=>{data+=b.toString();if(/\r?\n$/.test(data)){cleanup();resolve(data);}};const onErr=(e:Error)=>{cleanup();reject(e)};const cleanup=()=>{active.off("data",onData);active.off("error",onErr)};active.on("data",onData);active.on("error",onErr);});
  const cmd=async(command:string,expected:number[])=>{active.write(command+"\r\n");const reply=await read();const code=Number(reply.slice(0,3));if(!expected.includes(code))throw new Error("SMTP_"+code);return reply;};
  const greeting=await read();if(Number(greeting.slice(0,3))!==220)throw new Error("SMTP_GREETING");
  const ehlo=await cmd("EHLO testagram.site",[250]);
  if(!this.o.secure&&/STARTTLS/i.test(ehlo)){await cmd("STARTTLS",[220]);active=tls.connect({socket:active as net.Socket,servername:this.o.host});await new Promise<void>((resolve,reject)=>{(active as tls.TLSSocket).once("secureConnect",()=>resolve()).once("error",reject)});await cmd("EHLO testagram.site",[250]);}
  await cmd("AUTH LOGIN",[334]);await cmd(Buffer.from(this.o.username).toString("base64"),[334]);await cmd(Buffer.from(this.o.password).toString("base64"),[235]);
  await cmd(`MAIL FROM:<${extractEmail(mail.from)}>`,[250]);
  for(const recipient of mail.to)await cmd(`RCPT TO:<${recipient}>`,[250,251]);
  await cmd("DATA",[354]);
  active.write(buildMime(mail));
  active.write("\r\n.\r\n");
  await read().then(reply=>{if(Number(reply.slice(0,3))!==250)throw new Error("SMTP_DATA");});
  active.end();
 }
}
function extractEmail(value:string){const match=value.match(/<([^>]+)>/);return match?match[1]:value;}
function clean(value:string){return value.replace(/[\r\n]/g," ").trim();}
function buildMime(m:Mail){
 const boundary="=_Testagram_"+m.id.replace(/[^a-zA-Z0-9]/g,"");
 const lines=[
  `From: ${clean(m.from)}`,`To: ${m.to.map(clean).join(", ")}`,`Subject: ${clean(m.subject)}`,"MIME-Version: 1.0",`Content-Type: multipart/alternative; boundary="${boundary}"`,"Date: "+new Date().toUTCString(),"Message-ID: <"+m.id+"@testagram.site>",""
 ];
 if(m.text)lines.push("--"+boundary,"Content-Type: text/plain; charset=utf-8","Content-Transfer-Encoding: 8bit","",m.text,"");
 if(m.html)lines.push("--"+boundary,"Content-Type: text/html; charset=utf-8","Content-Transfer-Encoding: 8bit","",m.html,"");
 lines.push("--"+boundary+"--","");
 return lines.join("\r\n").replace(/^\./gm,"..");
}
