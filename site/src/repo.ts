export const REPO = "https://github.com/bens-schreiber/horse-holder";

export function source(path: string): string {
  return `${REPO}/blob/main/${path}`;
}
