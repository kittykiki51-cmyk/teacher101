const form = document.querySelector("#loginForm");
const password = document.querySelector("#password");
const toggle = document.querySelector("#togglePassword");
const button = document.querySelector("#loginButton");
const errorMessage = document.querySelector("#errorMessage");

function resetLoginState(clearPassword = false) {
  button.disabled = false;
  button.textContent = "登入";
  password.type = "password";
  toggle.textContent = "顯示";
  toggle.setAttribute("aria-label", "顯示密碼");
  if (clearPassword) password.value = "";
}

window.addEventListener("pageshow", (event) => {
  resetLoginState(event.persisted);
});

toggle.addEventListener("click", () => {
  const visible = password.type === "text";
  password.type = visible ? "password" : "text";
  toggle.textContent = visible ? "顯示" : "隱藏";
  toggle.setAttribute("aria-label", visible ? "顯示密碼" : "隱藏密碼");
  password.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorMessage.textContent = "";
  button.disabled = true;
  button.textContent = "登入中...";
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "登入失敗");
    window.location.replace("/");
  } catch (error) {
    errorMessage.textContent = error.message;
    password.select();
  } finally {
    resetLoginState(false);
  }
});
