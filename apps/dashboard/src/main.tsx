import { CheckCircle, Warning } from "@phosphor-icons/react";
import { STACKS_CORE_4_0_0 } from "@stx-labs/signer-sidekick-protocol";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../../design/tokens/tokens.css";
import "./styles.css";

function App() {
  return (
    <main className="app-shell" data-network="mainnet">
      <header className="topbar">
        <span className="product-name">Signer Sidekick</span>
        <span className="network-badge">Mainnet Profile</span>
      </header>
      <section className="content" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">PROTOCOL FOUNDATION</p>
          <h1 id="page-title" className="heading-sm">
            PoX-5 Operator Console
          </h1>
          <p className="summary">
            The application shell is ready. Pool and registration data are added in the activation
            setup milestone.
          </p>
        </div>
        <div className="status-grid">
          <article className="quiet-card">
            <div className="card-heading">
              <CheckCircle aria-hidden="true" weight="bold" />
              <h2>Protocol Pin</h2>
            </div>
            <p className="identifier">stacks-core {STACKS_CORE_4_0_0.tag}</p>
            <p className="muted identifier">{STACKS_CORE_4_0_0.commit}</p>
          </article>
          <article className="quiet-card">
            <div className="card-heading caution">
              <Warning aria-hidden="true" weight="bold" />
              <h2>Deployment Status</h2>
            </div>
            <p>Reference manager principals require independent production confirmation.</p>
          </article>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
