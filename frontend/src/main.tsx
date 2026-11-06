import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { Admin } from "./admin/Admin";
import { SessionProvider, SignIn, SignUp } from "./app/Auth";
import { Workspace } from "./app/Workspace";
import { hideFromSearch } from "./shop/head";
import { Shop } from "./shop/Shop";
import { Toasts } from "./ui/kit";
import { initTheme } from "./ui/Shell";

initTheme();

// Only storefronts (/s/...) may appear in search results; the workspace and admin never do.
function SearchGuard() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (!pathname.startsWith("/s/")) hideFromSearch();
  }, [pathname]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SearchGuard />
      <SessionProvider>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/signup" element={<SignUp />} />
          <Route path="/admin/*" element={<Admin />} />
          <Route path="/s/:slug/*" element={<Shop />} />
          <Route path="/*" element={<Workspace />} />
        </Routes>
      </SessionProvider>
      <Toasts />
    </BrowserRouter>
  </StrictMode>,
);
