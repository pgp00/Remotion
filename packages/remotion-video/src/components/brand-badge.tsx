import type {BrandTheme} from "@auto-video/shared";
import type {CSSProperties} from "react";

export const BrandBadge = ({brand}: {brand: BrandTheme}) => {
  const style: CSSProperties = {
    position: "absolute",
    top: 78,
    left: 66,
    display: "flex",
    alignItems: "center",
    gap: 16,
    color: brand.text,
    fontFamily: brand.fontFamily,
    fontSize: 25,
    fontWeight: 800,
    letterSpacing: 4,
  };

  return (
    <div style={style}>
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 99,
          backgroundColor: brand.primary,
          boxShadow: `0 0 24px ${brand.primary}`,
        }}
      />
      {brand.name}
    </div>
  );
};
