import React from "react";
import { Providers } from "./providers";
import OmniVMDApp from "../OmniVMDApp";

export default function HomePage() {
  return (
    <Providers>
      <OmniVMDApp />
    </Providers>
  );
}
