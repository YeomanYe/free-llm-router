import { providers, type Provider } from "../data";
import { useReveal } from "../useReveal";
import "./Providers.css";

function StatusChip({ status }: { status: Provider["status"] }) {
  const label = status === "free" ? "free" : status === "credit" ? "credit" : "action";
  return <span className={`chip chip-${status}`}>{label}</span>;
}

export default function Providers() {
  const ref = useReveal();
  const freeCount = providers.filter((p) => p.status === "free").length;

  return (
    <section id="providers" className="providers">
      <div className="wrap providers-inner" ref={ref}>
        <div className="providers-header reveal">
          <span className="eyebrow">Supported providers</span>
          <h2 className="section-title">
            {freeCount} genuinely free providers.
            <br />
            <span className="providers-title-sub">One row per key.</span>
          </h2>
          <p className="providers-lead">
            Every entry below is a first-class provider in{" "}
            <span className="mono">router.config.example.json</span>. Quotas are the
            public free-tier limits at the time of writing — the router won&rsquo;t
            invent numbers for you, so treat the policy column as reference, not
            contract.
          </p>
        </div>

        <div className="providers-table-wrap reveal">
          <table className="providers-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Env variable</th>
                <th>Models</th>
                <th>Free quota</th>
                <th>Policy</th>
                <th aria-label="Sign up" />
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.name}>
                  <td>
                    <div className="provider-name-wrap">
                      <StatusChip status={p.status} />
                      <span className="provider-name">{p.name}</span>
                    </div>
                  </td>
                  <td className="mono provider-env">{p.envVar}</td>
                  <td className="provider-models">{p.models}</td>
                  <td className="tnum provider-quota">{p.quota}</td>
                  <td className="provider-policy">{p.policy}</td>
                  <td className="provider-cta">
                    {p.applyUrl && (
                      <a href={p.applyUrl} target="_blank" rel="noreferrer">
                        Get key ↗
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="providers-note reveal">
          The router applies the same numeric-suffix expansion to every env variable,
          so <span className="mono">OPEN_ROUTER_API_KEY2</span>,{" "}
          <span className="mono">GOOGLE_API_KEY2</span>, etc. become independent
          fallback provider instances automatically.
        </p>
      </div>
    </section>
  );
}
