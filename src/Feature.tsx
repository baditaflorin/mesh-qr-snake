import { useEffect, useRef, useState } from "react";
import type { MeshConfig, YRoom } from "@baditaflorin/mesh-common";
import QRCode from "qrcode";
import jsQR from "jsqr";

type Props = { room: YRoom | null; config: MeshConfig };

type Hop = {
  /** Who held the token at this hop. */
  peerId: string;
  /** Display name at that moment. */
  name: string;
  /** Monotonic counter — gets handed to the next peer. */
  counter: number;
  ts: number;
};

const NAME_KEY = (prefix: string) => `${prefix}:displayName`;

export function Feature({ room, config }: Props) {
  if (!room) {
    return (
      <div className="qs-screen">
        <h1>qr snake</h1>
        <p className="qs-status">Connecting…</p>
      </div>
    );
  }
  return <Body room={room} config={config} />;
}

function Body({ room, config }: { room: YRoom; config: MeshConfig }) {
  const [name, setName] = useState(
    () => localStorage.getItem(NAME_KEY(config.storagePrefix)) ?? "",
  );
  const [, rerender] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [pasteVal, setPasteVal] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [myQR, setMyQR] = useState<string>("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (name) localStorage.setItem(NAME_KEY(config.storagePrefix), name);
  }, [name, config.storagePrefix]);

  useEffect(() => {
    const yHops = room.doc.getArray<Hop>("hops");
    const onChange = () => rerender((n) => n + 1);
    yHops.observe(onChange);
    return () => yHops.unobserve(onChange);
  }, [room]);

  const hops = room.doc.getArray<Hop>("hops").toArray();
  const lastHop = hops[hops.length - 1] ?? null;
  const counter = lastHop?.counter ?? 0;
  const isMyTurn = !lastHop || lastHop.peerId !== room.peerId;
  // The token to encode: identifies room + peer + counter. Each peer's QR
  // changes whenever their counter changes.
  const myToken = JSON.stringify({ p: room.peerId, c: counter + (isMyTurn ? 0 : 1) });

  // Render my QR
  useEffect(() => {
    QRCode.toDataURL(myToken, { errorCorrectionLevel: "M", margin: 1, width: 320 })
      .then(setMyQR)
      .catch(() => setMyQR(""));
  }, [myToken]);

  // Camera scan loop
  useEffect(() => {
    if (!scanning) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const loop = () => {
          const v = videoRef.current;
          if (v && ctx && v.videoWidth > 0) {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            ctx.drawImage(v, 0, 0);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height);
            if (code && code.data) {
              consumeToken(code.data);
              return;
            }
          }
          rafRef.current = requestAnimationFrame(loop);
        };
        loop();
      } catch (err) {
        setScanError(`Camera denied: ${(err as Error).message}`);
        setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scanning]);

  const consumeToken = (raw: string) => {
    setScanning(false);
    try {
      const parsed = JSON.parse(raw) as { p?: string; c?: number };
      if (!parsed.p || typeof parsed.c !== "number") {
        setScanError("That QR doesn't look like a snake token.");
        return;
      }
      if (parsed.p === room.peerId) {
        setScanError("That's your own QR.");
        return;
      }
      const myName = name.trim() || `peer-${room.peerId.slice(0, 4)}`;
      const yHops = room.doc.getArray<Hop>("hops");
      // First peer to receive a hop adds the previous holder's record (if missing),
      // then their own.
      const last = yHops.toArray()[yHops.length - 1];
      if (!last || last.peerId !== parsed.p) {
        // Synthesize the previous hop (so the chain is visible) if we missed it.
        yHops.push([
          {
            peerId: parsed.p,
            name: `peer-${parsed.p.slice(0, 4)}`,
            counter: parsed.c,
            ts: Date.now(),
          },
        ]);
      }
      yHops.push([{ peerId: room.peerId, name: myName, counter: parsed.c + 1, ts: Date.now() }]);
      setScanError(null);
    } catch {
      setScanError("Couldn't parse that QR.");
    }
  };

  const reset = () => {
    const yHops = room.doc.getArray<Hop>("hops");
    yHops.delete(0, yHops.length);
  };

  return (
    <div className="qs-screen">
      <header className="qs-header">
        <h1>qr snake</h1>
        <input
          className="qs-name"
          placeholder="your name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={32}
        />
        <p className="qs-status">
          hop {counter} · {hops.length} hops in this chain
        </p>
      </header>

      {myQR && (
        <div className="qs-qr-wrap">
          <p className="qs-qr-label">your QR (show this to the next phone)</p>
          <img src={myQR} alt="your QR token" className="qs-qr" />
        </div>
      )}

      {!scanning ? (
        <>
          <button type="button" className="qs-scan" onClick={() => setScanning(true)}>
            scan another phone&apos;s QR
          </button>
          <form
            className="qs-paste"
            onSubmit={(e) => {
              e.preventDefault();
              if (pasteVal.trim()) consumeToken(pasteVal.trim());
              setPasteVal("");
            }}
          >
            <input
              value={pasteVal}
              onChange={(e) => setPasteVal(e.target.value)}
              placeholder="…or paste a token here"
            />
            <button type="submit">pass</button>
          </form>
        </>
      ) : (
        <div className="qs-scanner">
          <video ref={videoRef} playsInline muted />
          <button type="button" className="qs-cancel" onClick={() => setScanning(false)}>
            cancel
          </button>
        </div>
      )}

      {scanError && <p className="qs-error">{scanError}</p>}

      {hops.length > 0 && (
        <>
          <ol className="qs-chain">
            {hops.map((h, i) => (
              <li key={`${i}-${h.peerId}`} className={h.peerId === room.peerId ? "is-me" : ""}>
                <span className="qs-chain-num">{h.counter}</span>
                <span className="qs-chain-name">{h.name}</span>
                <span className="qs-chain-time">{new Date(h.ts).toLocaleTimeString()}</span>
              </li>
            ))}
          </ol>
          <button type="button" className="qs-reset" onClick={reset}>
            reset chain
          </button>
        </>
      )}
    </div>
  );
}
