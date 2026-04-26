type StartWebLoginWithQr = typeof import("./src/login-qr.js").startWebLoginWithQr;
type StartWebLoginWithPairingCode = typeof import("./src/login-qr.js").startWebLoginWithPairingCode;
type WaitForWebLogin = typeof import("./src/login-qr.js").waitForWebLogin;

let loginQrModulePromise: Promise<typeof import("./src/login-qr.js")> | null = null;

function loadLoginQrModule() {
  loginQrModulePromise ??= import("./src/login-qr.js");
  return loginQrModulePromise;
}

export async function startWebLoginWithQr(
  ...args: Parameters<StartWebLoginWithQr>
): ReturnType<StartWebLoginWithQr> {
  const { startWebLoginWithQr } = await loadLoginQrModule();
  return await startWebLoginWithQr(...args);
}

export async function startWebLoginWithPairingCode(
  ...args: Parameters<StartWebLoginWithPairingCode>
): ReturnType<StartWebLoginWithPairingCode> {
  const { startWebLoginWithPairingCode } = await loadLoginQrModule();
  return await startWebLoginWithPairingCode(...args);
}

export async function waitForWebLogin(
  ...args: Parameters<WaitForWebLogin>
): ReturnType<WaitForWebLogin> {
  const { waitForWebLogin } = await loadLoginQrModule();
  return await waitForWebLogin(...args);
}
