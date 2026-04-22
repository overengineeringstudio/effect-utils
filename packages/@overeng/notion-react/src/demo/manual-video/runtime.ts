import * as Host from "../../components/mod.ts";

export const ui = Host;

export const keyed = <T extends object>(
  props: T,
  blockKey: string,
): T & { readonly blockKey: string } => ({
  ...props,
  blockKey,
});
