import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Admin } from "./admin/Admin";
import { SessionProvider, SignIn, SignUp } from "./app/Auth";
import { Workspace } from "./app/Workspace";
import { Toasts } from "./ui/kit";
import { initTheme } from "./ui/Shell";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/signup" element={<SignUp />} />
          <Route path="/admin/*" element={<Admin />} />
          <Route path="/*" element={<Workspace />} />
        </Routes>
      </SessionProvider>
      <Toasts />
    </BrowserRouter>
  </StrictMode>,
);
