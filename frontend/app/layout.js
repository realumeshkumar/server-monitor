import "./globals.css";

export const metadata = {
  title: "Server Monitor",
  description: "Live CPU, RAM, services and logs",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
