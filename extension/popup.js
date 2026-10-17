const dot = document.getElementById("dot");
const bridgeText = document.getElementById("bridgeText");
const portInput = document.getElementById("port");
const refresh = document.getElementById("refresh");

let port = 17321;

async function loadPort() {
  const v = await chrome.storage.local.get({ cm_bridgePort: 17321 });
  port = Number(v.cm_bridgePort) || 17321;
  portInput.value = String(port);
}

async function check() {
  bridgeText.textContent = "检查中…";
  dot.style.background = "#f59e0b";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
    const j = await res.json();
    if (j && j.ok) {
      dot.style.background = "#22c55e";
      bridgeText.textContent = `MCP 已连接 (v${j.version})`;
      return;
    }
  } catch {}
  dot.style.background = "#ef4444";
  bridgeText.textContent = "MCP 未连接";
}

portInput.addEventListener("change", async () => {
  const n = Number(portInput.value);
  if (!n || n < 1 || n > 65535) return;
  port = n;
  await chrome.storage.local.set({ cm_bridgePort: n });
  check();
});

refresh.addEventListener("click", check);

loadPort().then(check);
setInterval(check, 5000);
