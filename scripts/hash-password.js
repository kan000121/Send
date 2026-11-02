// BASIC_AUTH_USERS に設定するパスワードハッシュを生成する
// 使い方: npm run hash-password（入力は画面に表示されない。シェル履歴にも残らない）
import { hashPassword } from "../lib/password.js";

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
          stderr.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") { stdin.setRawMode(false); stderr.write("\n"); return reject(new Error("中断しました")); }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPiped() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

try {
  let password;
  if (process.stdin.isTTY) {
    password = await promptHidden("パスワード: ");
    if (password !== await promptHidden("もう一度: ")) throw new Error("パスワードが一致しません");
  } else {
    password = await readPiped();
  }
  if (password.length < 12) throw new Error("12文字以上にしてください");
  console.log(hashPassword(password));
  console.error("↑ を BASIC_AUTH_USERS の「ユーザー名:」の後ろに貼り付けてください（例: kanta:scrypt$...）");
} catch (e) {
  console.error(`[ERROR] ${e.message}`);
  process.exit(1);
}
