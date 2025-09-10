// ChannelsPicker.tsx
import { useEffect, useState } from "react";

export default function ChannelsPicker() {
  const [channels, setChannels] = useState<{id:string; name:string}[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [fileUrl, setFileUrl]   = useState("");
  const [title, setTitle]       = useState("");

  useEffect(() => {
    fetch("/api/channels").then(r => r.json()).then(setChannels);
  }, []);

  const toggle = (id: string) =>
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const submit = async () => {
    const r = await fetch("/api/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileUrl, title, channelIds: selected })
    });
    const data = await r.json();
    alert("done: " + JSON.stringify(data));
  };

  return (
    <div>
      <h3>ファイルURL</h3>
      <input value={fileUrl} onChange={e=>setFileUrl(e.target.value)} placeholder="https://..." />
      <h3>タイトル</h3>
      <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="資料名" />
      <h3>送信先</h3>
      <ul>
        {channels.map(c => (
          <li key={c.id}>
            <label>
              <input type="checkbox" checked={selected.includes(c.id)} onChange={()=>toggle(c.id)} />
              {c.name} ({c.id})
            </label>
          </li>
        ))}
      </ul>
      <button disabled={!fileUrl || selected.length===0} onClick={submit}>一斉共有</button>
    </div>
  );
}
