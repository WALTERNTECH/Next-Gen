import { BadgeCheck, Banknote, Boxes, Building2, ClipboardList, Columns3, FilePlus2, Gauge, Inbox, KeyRound, LayoutGrid, Lock, Package, PackagePlus, Plug, Settings2, ShieldCheck, ShoppingBag, ShoppingCart, Star, Store, Tags, Truck, UserCog, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { KIND_LABEL } from "../lib/format";
import { Loading, Tier } from "../ui/kit";
import { Shell, type Badge, type Hit, type NavGroup, type NavItem } from "../ui/Shell";
import { Certifications, Company, Dashboard, Payout, Privacy, Security } from "./account";
import { isSupplier, useSession } from "./Auth";
import { Catalog, Compare, ProductPage, SupplierProfile } from "./catalog";
import { MyProducts, ProductEditor } from "./products";
import { ApiAccess, ConsumerOrderPage, ConsumerOrders, Payouts, Reviews, RetailListings, StoreSettings } from "./merchant";
import { Dropship } from "./dropship";
import { OrderPage, Orders, RfqDetail, RfqNew, Rfqs } from "./trade";

// The signed-in company's workspace. Buyers and suppliers share the frame; the menu and routes
// follow the company's role (RBAC is enforced again on the server).

const HOME: NavItem = { to: "/", label: "Dashboard", icon: Gauge, end: true };

function navFor(kind: string): NavGroup[] {
  const account: NavGroup = {
    id: "account",
    label: "Company and account",
    icon: Building2,
    items: [
      { to: "/company", label: "Company and verification", icon: BadgeCheck, badge: "verification" },
      ...(kind !== "buyer"
        ? [
            { to: "/certifications", label: "Certifications", icon: ShieldCheck },
            { to: "/payout", label: "Payout account", icon: Wallet, badge: "payout" },
          ]
        : []),
      { to: "/security", label: "Security", icon: KeyRound, badge: "mfa" },
      { to: "/privacy", label: "Privacy and data", icon: Lock },
    ],
  };
  if (kind === "buyer")
    return [
      {
        id: "sourcing",
        label: "Sourcing",
        icon: ShoppingBag,
        items: [
          { to: "/catalog", label: "Catalog", icon: LayoutGrid },
          { to: "/compare", label: "Compare", icon: Columns3 },
        ],
      },
      {
        id: "trade",
        label: "Procurement",
        icon: ClipboardList,
        items: [
          { to: "/rfqs", label: "RFQs", icon: Inbox, badge: "proposals" },
          { to: "/rfqs/new", label: "New RFQ", icon: FilePlus2, end: true },
          { to: "/orders", label: "Wholesale orders", icon: ClipboardList, badge: "orders" },
        ],
      },
      {
        id: "retail",
        label: "Storefront",
        icon: Store,
        items: [
          { to: "/store", label: "Store settings", icon: Settings2, end: true },
          { to: "/store/listings", label: "Retail listings", icon: Tags },
          { to: "/store/orders", label: "Consumer orders", icon: ShoppingCart, badge: "to_ship" },
          { to: "/store/payouts", label: "Retail payouts", icon: Banknote },
          { to: "/store/reviews", label: "Reviews", icon: Star },
          { to: "/store/api", label: "API and sync", icon: Plug },
        ],
      },
      account,
    ];
  return [
    {
      id: "sales",
      label: "Sales",
      icon: Store,
      items: [
        { to: "/rfqs", label: "RFQ inbox", icon: Inbox, badge: "rfqs" },
        { to: "/orders", label: "Wholesale orders", icon: ClipboardList, badge: "orders" },
        { to: "/dropship", label: "Dropship orders", icon: Truck, badge: "dropship" },
      ],
    },
    {
      id: "catalog",
      label: "Listings",
      icon: Boxes,
      items: [
        { to: "/products", label: "My listings", icon: Package },
        { to: "/products/new", label: "New listing", icon: PackagePlus, end: true },
        { to: "/catalog", label: "Browse catalog", icon: LayoutGrid },
      ],
    },
    account,
  ];
}

export function Workspace() {
  const { me, loading, signOut } = useSession();
  const loc = useLocation();
  const nav = useNavigate();
  const [badges, setBadges] = useState<Record<string, Badge>>({});
  const loadBadges = useCallback(async () => {
    try {
      const d = await api.get("/me/dashboard");
      const todo = d.todo.length;
      setBadges({
        orders: { n: todo, tone: "wait" },
        proposals: { n: d.proposals_waiting ?? 0, tone: "" },
        rfqs: { n: d.rfqs_matching ?? 0, tone: "" },
        verification: { n: d.company.verification_status === "unsubmitted" || d.company.verification_status === "rejected" ? 1 : 0, tone: d.company.verification_status === "rejected" ? "bad" : "wait" },
        payout: { n: d.payout_set === false ? 1 : 0, tone: "wait" },
        mfa: { n: me?.user.mfa ? 0 : 1, tone: "wait" },
        to_ship: { n: d.retail?.to_ship ?? 0, tone: "wait" },
        dropship: { n: d.dropship_to_ship ?? 0, tone: "wait" },
      });
    } catch {
      /* badges are a convenience */
    }
  }, [me?.user.mfa]);
  useEffect(() => {
    if (me) void loadBadges();
  }, [me, loc.pathname, loadBadges]);

  if (loading) return <Loading />;
  if (!me) return <Navigate to="/signin" replace state={{ from: loc.pathname }} />;
  const supplier = isSupplier(me);
  const groups = navFor(me.user.company_kind);
  const search = async (q: string): Promise<Hit[]> => {
    const [rfqs, orders] = await Promise.all([api.get(`/rfqs${supplier ? "?scope=mine" : ""}`), api.get("/orders")]);
    const t = q.toLowerCase();
    return [
      ...orders.orders
        .filter((o: any) => `${o.ref} ${o.title} ${o.counterparty}`.toLowerCase().includes(t))
        .slice(0, 5)
        .map((o: any) => ({ key: `o${o.id}`, label: `${o.ref} · ${o.title}`, sub: o.counterparty, to: `/orders/${o.id}`, icon: <ClipboardList />, kind: "Order" })),
      ...rfqs.rfqs
        .filter((r: any) => `${r.ref} ${r.title}`.toLowerCase().includes(t))
        .slice(0, 5)
        .map((r: any) => ({ key: `r${r.id}`, label: `${r.ref} · ${r.title}`, sub: r.category_name, to: `/rfqs/${r.id}`, icon: <Inbox />, kind: "RFQ" })),
    ];
  };

  return (
    <Shell
      product={`${KIND_LABEL[me.user.company_kind]} workspace`}
      home={HOME}
      groups={groups}
      badges={badges}
      me={{ name: me.user.name, sub: me.user.email }}
      storageKey="ng.app"
      env={me.payments === "simulated" ? { label: "Test payments", title: "The payment gateway is in test mode: escrow movements are recorded but no money moves." } : null}
      search={search}
      context={
        <div className="ctx-card">
          <span className="monogram sq">{me.user.company_name.slice(0, 2).toUpperCase()}</span>
          <span className="grow" style={{ minWidth: 0 }}>
            <b className="ellipsis">{me.user.company_name}</b>
            <small className="row" style={{ gap: 6 }}>
              {KIND_LABEL[me.user.company_kind]} · <Tier tier={me.user.tier} short />
            </small>
          </span>
        </div>
      }
      menu={
        <>
          <button className="pop-row" onClick={() => nav("/company")}>
            <Building2 /> Company
          </button>
          <button className="pop-row" onClick={() => nav("/security")}>
            <UserCog /> Security
          </button>
        </>
      }
      onSignOut={async () => {
        await signOut();
        nav("/signin");
      }}
    >
      <Routes>
        <Route index element={<Dashboard />} />
        <Route path="catalog" element={<Catalog />} />
        <Route path="catalog/:id" element={<ProductPage />} />
        <Route path="compare" element={<Compare />} />
        <Route path="suppliers/:id" element={<SupplierProfile />} />
        <Route path="rfqs" element={<Rfqs />} />
        <Route path="rfqs/new" element={supplier ? <Navigate to="/rfqs" replace /> : <RfqNew />} />
        <Route path="rfqs/:id" element={<RfqDetail />} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:id" element={<OrderPage />} />
        <Route path="products" element={supplier ? <MyProducts /> : <Navigate to="/" replace />} />
        <Route path="products/:id" element={supplier ? <ProductEditor /> : <Navigate to="/" replace />} />
        <Route path="company" element={<Company />} />
        <Route path="certifications" element={<Certifications />} />
        <Route path="payout" element={<Payout />} />
        <Route path="security" element={<Security />} />
        <Route path="privacy" element={<Privacy />} />
        <Route path="store" element={supplier ? <Navigate to="/" replace /> : <StoreSettings />} />
        <Route path="store/listings" element={supplier ? <Navigate to="/" replace /> : <RetailListings />} />
        <Route path="store/orders" element={supplier ? <Navigate to="/" replace /> : <ConsumerOrders />} />
        <Route path="store/orders/:id" element={supplier ? <Navigate to="/" replace /> : <ConsumerOrderPage />} />
        <Route path="store/payouts" element={supplier ? <Navigate to="/" replace /> : <Payouts />} />
        <Route path="store/reviews" element={supplier ? <Navigate to="/" replace /> : <Reviews />} />
        <Route path="store/api" element={supplier ? <Navigate to="/" replace /> : <ApiAccess />} />
        <Route path="dropship" element={supplier ? <Dropship /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
