import "./globals.css";
import type { ReactNode } from "react";
export const metadata = { title: "Escrow Agent", description: "AI-verified milestone escrow for freelance gigs, powered by PayPal" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
