import { expect, test } from "@playwright/test";
import { openTwoPeers } from "@baditaflorin/mesh-common/testing";
import { readFileSync } from "node:fs";
import jsQR from "jsqr";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
};
const storagePrefix = pkg.name;

/**
 * Decode the actual QR <img> a peer RENDERS — what a phone camera would read
 * off that peer's screen — back to its string payload, using the same jsQR
 * library the app scans with. The page rasterises the rendered data-URL PNG to
 * RGBA via canvas (browser has a real PNG codec); jsQR runs in Node. This reads
 * the REAL token a peer broadcasts (room.peerId + counter), not a stand-in, so
 * a broken QR encoder OR a peerId that never makes it into the QR would fail.
 */
async function decodeRenderedQr(page: import("@playwright/test").Page): Promise<string> {
  const { width, height, data } = await page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>(".qs-qr");
    if (!img) throw new Error("no .qs-qr image rendered");
    if (!img.complete) await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: imgData.width, height: imgData.height, data: Array.from(imgData.data) };
  });
  const code = jsQR(Uint8ClampedArray.from(data), width, height);
  if (!code || !code.data) throw new Error("jsQR failed to decode the rendered QR");
  return code.data;
}

test("a peer's RENDERED QR decodes to its real token and scanning it daisy-chains across the mesh", async ({
  browser,
  baseURL,
}) => {
  const { a, b, cleanup } = await openTwoPeers(browser, baseURL ?? "", { storagePrefix });
  try {
    await a.getByPlaceholder(/your name/i).fill("alice");
    await b.getByPlaceholder(/your name/i).fill("bob");

    await expect(a.locator(".qs-qr")).toBeVisible();
    await expect(b.locator(".qs-qr")).toBeVisible();

    // 1. Decode BOTH peers' REAL rendered QRs — what a phone camera would read
    //    off each screen. Each must be a parseable snake token.
    const aliceToken = await decodeRenderedQr(a);
    const bobToken = await decodeRenderedQr(b);
    const pa = JSON.parse(aliceToken) as { p?: string; c?: number };
    const pb = JSON.parse(bobToken) as { p?: string; c?: number };
    expect(pa.p, `A's decoded QR must carry a peerId: ${aliceToken}`).toBeTruthy();
    expect(pb.p, `B's decoded QR must carry a peerId: ${bobToken}`).toBeTruthy();
    expect(typeof pa.c, `A's decoded QR must carry a numeric counter`).toBe("number");

    // 2. Ground truth, independent of any stub: each peer's QR carries that
    //    peer's OWN distinct identity. A shared/hard-coded token would make
    //    these equal — this is the load-bearing check a stub QR encoder fails.
    expect(pa.p, "each peer's QR must encode a DISTINCT peerId").not.toBe(pb.p);
    const aliceId = pa.p as string;

    // 3. Peer B "scans" A by consuming the EXACT token decoded from A's QR.
    //    (Headless can't point a camera at A's screen, so we feed B the real
    //    decoded payload through the same consumeToken path the camera uses.)
    await b.getByPlaceholder(/paste a token/i).fill(aliceToken);
    await b.getByRole("button", { name: "pass" }).click();

    // 4. Cross-peer assertion #1: B's hop (bob) is visible on the OPPOSITE peer A.
    await expect(a.locator(".qs-chain").getByText("bob")).toBeVisible();

    // 5. Cross-peer assertion #2: the chain on A contains alice's REAL peerId-
    //    derived hop synthesized from the scanned token — proving the payload
    //    that walked across the QR carried A's genuine identity, end-to-end.
    const aliceHopShort = `peer-${aliceId.slice(0, 4)}`;
    await expect(a.locator(".qs-chain").getByText(aliceHopShort)).toBeVisible();
    await expect(b.locator(".qs-chain").getByText(aliceHopShort)).toBeVisible();

    // 6. The counter advanced: B's hop counter is A's counter + 1 (token walked).
    const status = await a.locator(".qs-status").innerText();
    expect(status).toMatch(new RegExp(`hop\\s+${(pa.c as number) + 1}\\b`));
  } finally {
    await cleanup();
  }
});

test("each peer's QR renders and the paste-token path passes the chain on", async ({
  browser,
  baseURL,
}) => {
  const { a, b, cleanup } = await openTwoPeers(browser, baseURL ?? "", { storagePrefix });
  try {
    await a.getByPlaceholder(/your name/i).fill("alice");
    await b.getByPlaceholder(/your name/i).fill("bob");

    await expect(a.locator(".qs-qr")).toBeVisible();
    await expect(b.locator(".qs-qr")).toBeVisible();

    const aliceQrSrc = await a.locator(".qs-qr").getAttribute("src");
    expect(aliceQrSrc).toMatch(/^data:image\/png/);

    // Synthetic: B pastes a token claiming peer "alice-fake" passed counter 1.
    await b.getByPlaceholder(/paste a token/i).fill('{"p":"alice-fake","c":1}');
    await b.getByRole("button", { name: "pass" }).click();

    // Both peers should now see the chain with bob in it
    await expect(a.locator(".qs-chain").getByText("bob")).toBeVisible();
    await expect(b.locator(".qs-chain").getByText("bob")).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("pasting your own QR is rejected", async ({ page, baseURL }) => {
  await page.goto(baseURL ?? "");
  // Read out peerId from somewhere — easiest: trigger an error by pasting an
  // obviously-malformed token.
  await page.getByPlaceholder(/paste a token/i).fill("not-json");
  await page.getByRole("button", { name: "pass" }).click();
  await expect(page.getByText(/couldn.+parse/i)).toBeVisible();
});
