import Link from "next/link";
import UseMoneyLogo from "@/components/UseMoneyLogo";

const resourceLinks = [
  { href: "/blog", label: "Blog" },
  { href: "/glossary", label: "Glossary" },
  { href: "/docs", label: "Docs" },
];

const companyLinks = [
  { href: "/pricing", label: "Pricing" },
  { href: "/legal", label: "Legal Policies" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
];

const productLinks = [
  { href: "/home#features", label: "Features" },
  { href: "/sign-up", label: "Get Started" },
  { href: "/help", label: "Help Center" },
];

export function PublicFooter() {
  return (
    <footer className="border-t border-[var(--border-default)] bg-[var(--bg-card)] pt-12 pb-8 mt-16">
      <div className="max-w-[1200px] mx-auto px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <Link href="/home" className="flex items-center gap-2 mb-3">
              <UseMoneyLogo size={32} />
              <span className="font-bold text-lg text-[var(--text-primary)]">
                UseMoney<span className="text-emerald-400">.</span>
              </span>
            </Link>
            <p className="text-[13.5px] text-[var(--text-dim)] leading-relaxed max-w-[300px]">
              Your complete trading portfolio command center. Connect every
              broker, analyze every trade.
            </p>
          </div>

          {/* Resources */}
          <div>
            <h3 className="um-label mb-3">Resources</h3>
            <ul className="space-y-2">
              {resourceLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-[13.5px] text-[var(--text-dim)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Product */}
          <div>
            <h3 className="um-label mb-3">Product</h3>
            <ul className="space-y-2">
              {productLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-[13.5px] text-[var(--text-dim)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="um-label mb-3">Company</h3>
            <ul className="space-y-2">
              {companyLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-[13.5px] text-[var(--text-dim)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom */}
        <div className="border-t border-[var(--border-default)] pt-6 flex flex-col md:flex-row justify-between items-center gap-4 font-mono text-xs text-[var(--text-muted)]">
          <p>
            &copy; {new Date().getFullYear()} DIS Digital LLP &middot; Made in
            India
          </p>
          <p>
            <a
              href="https://www.disdigital.in"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              disdigital.in
            </a>{" "}
            &middot; All systems operational{" "}
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 ml-1 align-middle" />
          </p>
        </div>
      </div>
    </footer>
  );
}
