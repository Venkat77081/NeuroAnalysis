"""A tiny SMTP server for tests: speaks enough SMTP for smtplib (EHLO, AUTH PLAIN, MAIL, RCPT, DATA,
QUIT) and keeps what it receives. No TLS (tests use smtp_security "none")."""

import base64
import email
import socketserver
import threading
from email.message import Message


class FakeSmtp:
    def __init__(self) -> None:
        self.messages: list[Message] = []
        self.envelopes: list[tuple[str, list[str]]] = []
        self.logins: list[tuple[str, str]] = []
        outer = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                def w(line: str) -> None:
                    self.wfile.write((line + "\r\n").encode())

                w("220 fake ESMTP")
                sender, rcpts = "", []
                while True:
                    raw = self.rfile.readline()
                    if not raw:
                        return
                    line = raw.decode().rstrip("\r\n")
                    cmd = line.upper()
                    if cmd.startswith(("EHLO", "HELO")):
                        w("250-fake")
                        w("250 AUTH PLAIN")
                    elif cmd.startswith("AUTH PLAIN"):
                        _, user, pw = base64.b64decode(line.split()[2]).decode().split("\0")
                        outer.logins.append((user, pw))
                        w("235 ok")
                    elif cmd.startswith("MAIL FROM:"):
                        sender, rcpts = line[10:].strip("<> "), []
                        w("250 ok")
                    elif cmd.startswith("RCPT TO:"):
                        rcpts.append(line[8:].strip("<> "))
                        w("250 ok")
                    elif cmd == "DATA":
                        w("354 go on")
                        data = b""
                        while not data.endswith(b"\r\n.\r\n"):
                            data += self.rfile.readline()
                        outer.messages.append(email.message_from_bytes(data[:-5]))
                        outer.envelopes.append((sender, rcpts))
                        w("250 queued")
                    elif cmd == "QUIT":
                        w("221 bye")
                        return
                    else:
                        w("250 ok")

        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
