import { createHash, createSign, randomUUID } from "node:crypto";
import { resolveMx } from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { config } from "./config.js";
import type { MailRecord } from "./types.js";

type Sock = net.Socket | tls.TLSSocket;

function addr(value: string) {
  const match = value.match(/<([^>]+)>/) ?? value.match(/([\w.+-]+@[\w.-]+)/);
  if (!match) throw new Error("INVALID_EMAIL");
  return match[1];
}

function domain(value: string) {
  return addr(value).split("@").pop()!.toLowerCase();
}

function clean(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function readResponse(socket: Sock): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("SMTP_TIMEOUT"));
    }, config.smtpTimeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n");
      for (const line of lines) {
        if (/^\d{3} /.test(line)) {
          cleanup();
          resolve(line);
          return;
        }
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function command(socket: Sock, commandText: string, expected: number[]) {
  socket.write(commandText + "\r\n");
  const response = await readResponse(socket);
  const code = Number(response.slice(0, 3));
  if (!expected.includes(code)) throw new Error("SMTP_" + response);
}

async function ehlo(socket: Sock): Promise<Set<string>> {
  socket.write("EHLO " + config.heloName + "\r\n");
  return await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("SMTP_EHLO_TIMEOUT"));
    }, config.smtpTimeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n");
      if (!lines.some((line) => /^250 /.test(line))) return;
      cleanup();
      resolve(
        new Set(
          lines
            .filter((line) => /^250[- ]/.test(line))
            .map((line) => line.slice(4).trim().split(/\s+/)[0].toUpperCase()),
        ),
      );
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function connect(host: string) {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(25, host, () => resolve(socket));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SMTP_CONNECT_TIMEOUT"));
    }, config.smtpTimeoutMs);
    socket.once("connect", () => clearTimeout(timer));
    socket.once("error", reject);
  });
}

async function startTls(socket: net.Socket) {
  await command(socket, "STARTTLS", [220]);
  return await new Promise<tls.TLSSocket>((resolve, reject) => {
    const secure = tls.connect(
      { socket, servername: config.heloName, rejectUnauthorized: true },
      () => resolve(secure),
    );
    secure.once("error", reject);
  });
}

function messageBody(mail: MailRecord) {
  if (!mail.html_body) {
    return [
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      mail.text_body ?? "",
    ].join("\r\n");
  }

  const boundary = "=_Testagram_" + randomUUID().replaceAll("-", "");
  return [
    "MIME-Version: 1.0",
    \`Content-Type: multipart/alternative; boundary="\${boundary}"\`,
    "",
    \`--\${boundary}\`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    mail.text_body ?? "",
    \`--\${boundary}\`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    mail.html_body,
    \`--\${boundary}--\`,
  ].join("\r\n");
}

function dkimHeader(
  mail: MailRecord,
  body: string,
  from: string,
  to: string,
  date: string,
  messageId: string,
) {
  if (!config.dkimPrivateKey) return null;

  const canonicalBody =
    body.replace(/\r?\n/g, "\r\n").replace(/(?:\r\n)*$/, "") + "\r\n";
  const bodyHash = createHash("sha256").update(canonicalBody).digest("base64");
  const value =
    \`v=1; a=rsa-sha256; c=relaxed/simple; d=\${config.mailDomain}; s=\${config.dkimSelector}; h=from:to:subject:date:message-id; bh=\${bodyHash}; b=\`;

  const canonicalHeaders = [
    ["from", from],
    ["to", to],
    ["subject", mail.subject],
    ["date", date],
    ["message-id", messageId],
  ]
    .map(([key, value]) => key + ":" + clean(value))
    .join("\r\n");

  const signer = createSign("RSA-SHA256");
  signer.update(canonicalHeaders + "\r\ndkim-signature:" + value);
  return "DKIM-Signature: " + value + signer.sign(config.dkimPrivateKey, "base64");
}

export async function deliver(mail: MailRecord) {
  const from = addr(mail.from_address);
  const groups = new Map<string, string[]>();

  for (const raw of mail.to_addresses) {
    const recipient = addr(raw);
    const d = domain(recipient);
    groups.set(d, [...(groups.get(d) ?? []), recipient]);
  }

  for (const [recipientDomain, recipients] of groups) {
    const mx = (await resolveMx(recipientDomain)).sort(
      (a, b) => a.priority - b.priority,
    );
    if (!mx.length) throw new Error("NO_MX_" + recipientDomain);

    let delivered = false;
    let lastError = "SMTP_DELIVERY_FAILED";

    for (const record of mx) {
      let socket: Sock | null = null;

      try {
        const rawSocket = await connect(record.exchange);
        socket = rawSocket;

        const greeting = await readResponse(socket);
        if (!greeting.startsWith("220")) throw new Error("SMTP_GREETING_" + greeting);

        let features = await ehlo(socket);
        if (features.has("STARTTLS")) {
          socket = await startTls(rawSocket);
          features = await ehlo(socket);
        }

        await command(socket, "MAIL FROM:<" + from + ">", [250]);
        for (const recipient of recipients) {
          await command(socket, "RCPT TO:<" + recipient + ">", [250, 251]);
        }

        const date = new Date().toUTCString();
        const messageId = "<" + randomUUID() + "@" + config.mailDomain + ">";
        const body = messageBody(mail);
        const toHeader = recipients.join(", ");

        const headers = [
          "From: " + clean(mail.from_address),
          "To: " + clean(toHeader),
          "Subject: " + clean(mail.subject),
          "Date: " + date,
          "Message-ID: " + messageId,
          "MIME-Version: 1.0",
          mail.reply_to ? "Reply-To: " + clean(mail.reply_to) : null,
          dkimHeader(mail, body, mail.from_address, toHeader, date, messageId),
          "X-Mailer: Testagram Mail/1.0",
        ]
          .filter(Boolean)
          .join("\r\n");

        await command(socket, "DATA", [354]);
        const data =
          headers +
          "\r\n\r\n" +
          body.replace(/^\./gm, "..") +
          "\r\n.\r\n";
        socket.write(data);

        const accepted = await readResponse(socket);
        if (!/^250\b/.test(accepted)) throw new Error("SMTP_" + accepted);

        await command(socket, "QUIT", [221, 250]);
        socket.destroy();
        delivered = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        socket?.destroy();
      }
    }

    if (!delivered) throw new Error(lastError);
  }
}
