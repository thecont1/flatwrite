/**
 * Type bridge for the CommonJS font inventory in core/font-inventory.js.
 *
 * The inventory lives as a plain JS module so it can be loaded directly
 * by Vercel's Node runtime (without a build step). The MCP server, which
 * is TypeScript, imports it through this type-only declaration so tsc
 * knows the shape.
 */

declare module '*core/font-inventory.js' {
  export type FontFace = {
    file: string;
    weight: string;
    style: string;
  };
  export const FONT_INVENTORY: Readonly<Record<string, readonly FontFace[]>>;
  export const UNICODE_RANGE: string;
}
