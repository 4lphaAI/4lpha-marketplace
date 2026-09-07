"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/App.jsx).
   The state routing is the design's, unchanged: `route` drives the screen,
   `hired` / `hiring` / `empty` / `sheet` are still local mock state. The only
   change is the wallet: the design's `connected` boolean and `onConnect`
   handler are gone, because the header now reads real wagmi state. Mounting is
   Next's job, so the export's `mountKit()` polling loop is dropped. */
import React from "react";

import { Icon } from "@/design-system";
import { AGENTS } from "@/lib/design-data";
import { KitHeader } from "@/components/screens/KitHeader";
import { NoticeBanner } from "@/components/NoticeBanner";
import { MarketplaceScreen } from "@/components/screens/MarketplaceScreen";
import { DeployAgentScreen } from "@/components/screens/DeployAgentScreen";
import { AgentDetailScreen } from "@/components/screens/AgentDetailScreen";
import { HireFlow } from "@/components/screens/HireFlow";
import { MyAgentsScreen } from "@/components/screens/MyAgentsScreen";
import { HiredAgentScreen } from "@/components/screens/HiredAgentScreen";
import { ListAgentScreen } from "@/components/screens/ListAgentScreen";
import { DemoAgentDetail } from "@/components/demo/DemoAgentDetail";

export function KitApp() {
  const [route, setRoute] = React.useState("/");
  const [hiring, setHiring] = React.useState<Record<string, unknown> | null>(null);
  const [empty, setEmpty] = React.useState(false);
  const [sheet, setSheet] = React.useState(false);
  const [search, setSearch] = React.useState("");

  // URL <-> state route sync: the initial route comes from the address bar (so
  // `/account/<id>` deep links and reloads work through the catch-all page), `go`
  // pushes history, and back/forward restore the state route. Read in an
  // effect, not in the initialiser, so the server render and the first client
  // render agree.
  React.useEffect(() => {
    const normalize = (path: string) => path === "/my" || path.startsWith("/my/") ? `/account${path.slice(3)}` : path;
    const fromUrl = normalize(window.location.pathname);
    if (fromUrl !== "/" && fromUrl !== route) {
      setRoute(fromUrl);
      if (fromUrl !== window.location.pathname) window.history.replaceState(null, "", fromUrl);
    }
    const onPop = () => setRoute(normalize(window.location.pathname || "/"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const onResize = () => setSheet(window.innerWidth < 720);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const go = (r: string) => {
    setRoute(r);
    if (window.location.pathname !== r) window.history.pushState(null, "", r);
    window.scrollTo(0, 0);
  };
  const agentFrom = (prefix: string) => AGENTS.find((a) => a.id === route.slice(prefix.length)) || AGENTS[0];

  let screen;
  if (route.startsWith("/agent/")) screen = <AgentDetailScreen agent={agentFrom("/agent/")} go={go} onHire={setHiring} />;
  else if (route.startsWith("/account/")) screen = <HiredAgentScreen agentId={route.slice("/account/".length)} go={go} />;
  else if (route === "/account") screen = <MyAgentsScreen go={go} />;
  else if (route.startsWith("/deploy/")) screen = <DeployAgentScreen key={route} kind={route.slice(8) === "lending" ? "health" : route.slice(8)} go={go} />;
  else if (route.startsWith("/demo/")) screen = <DemoAgentDetail demoId={route.slice("/demo/".length)} go={go} />;
  else if (route === "/list-your-agent") screen = <ListAgentScreen go={go} />;
  else screen = <MarketplaceScreen go={go} onHire={setHiring} search={search} />;

  return (
    <div className="fl-page">
      <NoticeBanner />
      <KitHeader route={route} go={go} search={search} onSearchChange={setSearch} />
      {/* Below the header the app is desktop-only for now. The gate is CSS, not
          a width read, so the server render and the first client render agree
          and no screen has to know about it — and nothing about the desktop
          layout moves. */}
      <div className="fl-desktop-only">
        {screen}
        {hiring && (
          <HireFlow agent={hiring} sheet={sheet} onClose={() => setHiring(null)}
            onDone={() => { setHiring(null); setEmpty(false); go("/account"); }} />
        )}
      </div>
      <div className="fl-mobile-gate" role="status">
        <Icon name="info" size={22} />
        <p>We do not support mobile yet. Please open 4lpha on a desktop browser for the best experience.</p>
      </div>
    </div>
  );
}
