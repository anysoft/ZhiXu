import { PRODUCT_NAME } from '../../back/shared/brand';
export { PRODUCT_NAME };

export function productTitle(page: string, customTitle = ''): string {
  const custom = customTitle.trim();
  return [PRODUCT_NAME, page, custom && custom !== PRODUCT_NAME ? custom : '']
    .filter(Boolean)
    .join(' · ');
}
