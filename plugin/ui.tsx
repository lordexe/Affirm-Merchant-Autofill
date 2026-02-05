const root = document.createElement("div");
root.style.fontFamily = "Inter, sans-serif";
root.style.padding = "16px";
root.style.display = "flex";
root.style.flexDirection = "column";
root.style.gap = "12px";

root.innerHTML = `
  <label style="font-size: 12px; font-weight: 600;">Merchant names (comma-separated)</label>
  <textarea id="merchant-input" rows="5" style="width: 100%; font-size: 12px;"></textarea>
  <button id="run-button" style="padding: 8px 12px; font-size: 12px;">Run</button>
`;

document.body.appendChild(root);

const input = document.getElementById("merchant-input") as HTMLTextAreaElement | null;
const button = document.getElementById("run-button") as HTMLButtonElement | null;

button?.addEventListener("click", () => {
  const merchantString = input?.value || "";
  parent.postMessage(
    { pluginMessage: { type: "RUN_MERCHANT_AUTOFILL", payload: merchantString } },
    "*"
  );
});
