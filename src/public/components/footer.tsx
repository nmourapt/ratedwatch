// Minimal site footer. No tracking, no cookie banner — we don't do either.
// The © year is computed at render time; that's safe because Workers
// execute per-request and the value doesn't leak across tenants.
export const Footer = () => {
  const year = new Date().getUTCFullYear();
  return (
    <footer class="cf-footer">
      <div class="cf-container cf-footer__inner">
        <span>
          © {year} rated.watch — competitive accuracy tracking for watch enthusiasts.
        </span>
        <nav aria-label="Footer">
          <a href="/">Home</a>
        </nav>
      </div>
    </footer>
  );
};
