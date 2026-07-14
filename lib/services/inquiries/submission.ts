import { createInquiryWithItems } from "@/lib/repositories/inquiries";
import { getLatestProductsForInquiry } from "@/lib/repositories/products";
import type { InquiryCreateRecord, ValidatedInquiryItem } from "./validation";
import type { Inquiry, InquiryItem } from "@/types/database";

export interface InquirySubmissionResult {
  inquiry: Inquiry;
  submittedProductCount: number;
}

export async function submitInquiry(
  record: InquiryCreateRecord,
  requestedItems: ValidatedInquiryItem[]
): Promise<InquirySubmissionResult> {
  const submittedItems = requestedItems.length || !record.product_id
    ? requestedItems
    : [{
        product_id: record.product_id,
        slug: record.product_slug || "",
        name_cn: record.interested_product,
        name_en: null,
        cover_image_url: null,
        quantity: record.quantity || "",
      }];
  const latestProducts = await getLatestProductsForInquiry(submittedItems);
  const latestById = new Map(latestProducts.map((product) => [product.id, product]));
  const items = submittedItems.map((item, index) => {
    const latest = latestById.get(item.product_id);
    return {
      product_id: latest?.id || null,
      product_slug: latest?.slug || item.slug,
      product_name_cn: latest?.name_cn || item.name_cn,
      product_name_en: latest?.name_en || item.name_en,
      quantity: item.quantity || null,
      sort_order: index,
    };
  });

  if (items.length) {
    const first = items[0];
    record = {
      ...record,
      interested_product: items.map((item) => item.product_name_cn || item.product_name_en || item.product_slug).filter(Boolean).join("；"),
      quantity: items.length === 1 ? first.quantity : null,
      product_id: first.product_id,
      product_slug: first.product_slug,
    };
  }

  const inquiry = await createInquiryWithItems(record, items);
  inquiry.inquiry_items = items.map((item, index): InquiryItem => ({
    id: `submitted-${index}`,
    inquiry_id: inquiry.id,
    product_id: item.product_id,
    product_slug: item.product_slug,
    product_name_cn: item.product_name_cn,
    product_name_en: item.product_name_en,
    quantity: item.quantity,
    sort_order: item.sort_order,
    created_at: inquiry.created_at,
  }));
  return { inquiry, submittedProductCount: items.length };
}
