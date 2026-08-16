export const REPO = "https://github.com/bschreib/horse-holder";

export function source(path: string): string {
  return `${REPO}/blob/main/${path}`;
}
