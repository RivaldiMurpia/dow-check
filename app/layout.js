// Root layout for the dow-check mobile web app.
import "./globals.css";

export const metadata = {
  title: "DOW Check — Cek dulu, baru putuskan",
  description: "Proof-first research assistant for Indonesian small merchants.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
