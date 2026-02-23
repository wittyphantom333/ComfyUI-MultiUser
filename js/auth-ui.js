/**
 * ComfyUI-MultiUser — Login & Registration UI
 * Creates a full-screen overlay for authentication when user is not logged in.
 */

import { checkSetupStatus, storeToken } from "./api.js";

const STYLES = `
  .mu-auth-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.92);
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .mu-auth-card {
    background: #1e1e2e;
    border: 1px solid #444;
    border-radius: 12px;
    padding: 40px;
    width: 400px;
    max-width: 90vw;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .mu-auth-card h2 {
    margin: 0 0 24px 0;
    color: #e0e0e0;
    font-size: 22px;
    text-align: center;
  }
  .mu-auth-card .mu-subtitle {
    color: #888;
    text-align: center;
    margin: -16px 0 24px 0;
    font-size: 13px;
  }
  .mu-auth-field {
    margin-bottom: 16px;
  }
  .mu-auth-field label {
    display: block;
    color: #aaa;
    font-size: 13px;
    margin-bottom: 6px;
  }
  .mu-auth-field input {
    width: 100%;
    padding: 10px 12px;
    background: #2a2a3e;
    border: 1px solid #555;
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 14px;
    box-sizing: border-box;
    outline: none;
    transition: border-color 0.2s;
  }
  .mu-auth-field input:focus {
    border-color: #7c6cff;
  }
  .mu-auth-btn {
    width: 100%;
    padding: 12px;
    background: #7c6cff;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    margin-top: 8px;
    transition: background 0.2s;
  }
  .mu-auth-btn:hover {
    background: #6a5aee;
  }
  .mu-auth-btn:disabled {
    background: #555;
    cursor: not-allowed;
  }
  .mu-auth-error {
    background: #3d1f1f;
    color: #ff6b6b;
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 13px;
    margin-bottom: 16px;
    display: none;
  }
  .mu-auth-error.visible {
    display: block;
  }
  .mu-auth-toggle {
    text-align: center;
    margin-top: 16px;
    color: #888;
    font-size: 13px;
  }
  .mu-auth-toggle a {
    color: #7c6cff;
    cursor: pointer;
    text-decoration: none;
  }
  .mu-auth-toggle a:hover {
    text-decoration: underline;
  }
  .mu-auth-success {
    background: #1f3d2a;
    color: #6bff8b;
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 13px;
    margin-bottom: 16px;
    display: none;
  }
  .mu-auth-success.visible {
    display: block;
  }
`;

let overlayEl = null;
let currentMode = "login"; // "login" | "register"

function injectStyles() {
  if (document.getElementById("mu-auth-styles")) return;
  const style = document.createElement("style");
  style.id = "mu-auth-styles";
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function showError(msg) {
  const el = overlayEl?.querySelector(".mu-auth-error");
  if (el) {
    el.textContent = msg;
    el.classList.add("visible");
  }
}

function clearError() {
  const el = overlayEl?.querySelector(".mu-auth-error");
  if (el) el.classList.remove("visible");
}

function buildLoginForm(isSetup) {
  return `
    <div class="mu-auth-card">
      <h2>${isSetup ? "🔧 Initial Setup" : "🔒 Sign In"}</h2>
      ${isSetup ? '<p class="mu-subtitle">Create the first admin account</p>' : ""}
      <div class="mu-auth-error"></div>
      <div class="mu-auth-success"></div>
      <form id="mu-auth-form">
        <div class="mu-auth-field">
          <label for="mu-username">Username</label>
          <input type="text" id="mu-username" name="username" autocomplete="username" required minlength="3" />
        </div>
        ${currentMode === "register" || isSetup ? `
        <div class="mu-auth-field">
          <label for="mu-email">Email (optional)</label>
          <input type="email" id="mu-email" name="email" autocomplete="email" />
        </div>
        ` : ""}
        <div class="mu-auth-field">
          <label for="mu-password">Password</label>
          <input type="password" id="mu-password" name="password" autocomplete="${currentMode === "register" || isSetup ? "new-password" : "current-password"}" required minlength="8" />
        </div>
        ${currentMode === "register" || isSetup ? `
        <div class="mu-auth-field">
          <label for="mu-password-confirm">Confirm Password</label>
          <input type="password" id="mu-password-confirm" name="password_confirm" autocomplete="new-password" required minlength="8" />
        </div>
        ` : ""}
        <button type="submit" class="mu-auth-btn" id="mu-submit-btn">
          ${isSetup ? "Create Admin Account" : (currentMode === "register" ? "Register" : "Sign In")}
        </button>
      </form>
      ${!isSetup ? `
      <div class="mu-auth-toggle" id="mu-auth-toggle-container">
        ${currentMode === "login"
          ? 'Don\'t have an account? <a id="mu-toggle-mode">Register</a>'
          : 'Already have an account? <a id="mu-toggle-mode">Sign In</a>'}
      </div>
      ` : ""}
    </div>
  `;
}

async function handleSubmit(e, isSetup) {
  e.preventDefault();
  clearError();

  const btn = overlayEl.querySelector("#mu-submit-btn");
  btn.disabled = true;
  btn.textContent = "Please wait...";

  const username = overlayEl.querySelector("#mu-username").value.trim();
  const password = overlayEl.querySelector("#mu-password").value;
  const email = overlayEl.querySelector("#mu-email")?.value.trim() || "";

  if (currentMode === "register" || isSetup) {
    const confirm = overlayEl.querySelector("#mu-password-confirm").value;
    if (password !== confirm) {
      showError("Passwords do not match");
      btn.disabled = false;
      btn.textContent = isSetup ? "Create Admin Account" : "Register";
      return;
    }
  }

  const endpoint = (currentMode === "register" || isSetup) ? "/multiuser/register" : "/multiuser/login";
  const body = { username, password };
  if (email) body.email = email;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || "An error occurred");
      btn.disabled = false;
      btn.textContent = isSetup ? "Create Admin Account" : (currentMode === "register" ? "Register" : "Sign In");
      return;
    }

    // Success — store token for Bearer-header fallback
    if (data.token) {
      storeToken(data.token);
    }

    // Store user info and remove overlay
    window.__multiuser_current_user = data.user;
    hideAuthOverlay();
    window.dispatchEvent(new CustomEvent("multiuser-auth-success", { detail: data.user }));
    
    // Reload to initialize ComfyUI with auth
    location.reload();
  } catch (err) {
    showError("Network error. Please try again.");
    btn.disabled = false;
    btn.textContent = isSetup ? "Create Admin Account" : (currentMode === "register" ? "Register" : "Sign In");
  }
}

export async function showAuthOverlay() {
  injectStyles();

  // Check if setup is needed
  let isSetup = false;
  try {
    const status = await checkSetupStatus();
    isSetup = status.needs_setup;
    if (!isSetup && status.registration_mode === "invite") {
      // Don't show register option in invite mode
      currentMode = "login";
    }
  } catch (e) {
    // If we can't reach the server, show login anyway
  }

  if (isSetup) {
    currentMode = "register";
  }

  overlayEl = document.createElement("div");
  overlayEl.className = "mu-auth-overlay";
  overlayEl.innerHTML = buildLoginForm(isSetup);
  document.body.appendChild(overlayEl);

  // Bind form
  overlayEl.querySelector("#mu-auth-form").addEventListener("submit", (e) => handleSubmit(e, isSetup));

  // Bind toggle
  const toggleBtn = overlayEl.querySelector("#mu-toggle-mode");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      currentMode = currentMode === "login" ? "register" : "login";
      overlayEl.innerHTML = buildLoginForm(false);
      // Re-bind
      overlayEl.querySelector("#mu-auth-form").addEventListener("submit", (e) => handleSubmit(e, false));
      const newToggle = overlayEl.querySelector("#mu-toggle-mode");
      if (newToggle) {
        newToggle.addEventListener("click", () => {
          currentMode = currentMode === "login" ? "register" : "login";
          // Recursive re-render. For a simple auth form, this is fine.
          overlayEl.remove();
          showAuthOverlay();
        });
      }
    });
  }

  // Focus first input
  setTimeout(() => overlayEl.querySelector("input")?.focus(), 100);
}

export function hideAuthOverlay() {
  overlayEl?.remove();
  overlayEl = null;
}

// Global hook so middleware can trigger login
window.__multiuser_show_login = showAuthOverlay;
