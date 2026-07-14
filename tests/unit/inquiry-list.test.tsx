// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  InquiryListProvider,
  useInquiryList,
} from "@/components/public/inquiry-list/InquiryListProvider";

function Harness() {
  const { add, clear, count } = useInquiryList();
  const product = {
    product_id: "11111111-1111-4111-8111-111111111111",
    slug: "board",
    name_cn: "防火板",
    name_en: "Fire Board",
    cover_image_url: null,
    quantity: "",
  };
  return (
    <>
      <output aria-label="count">{count}</output>
      <button type="button" onClick={() => add(product)}>
        Add
      </button>
      <button type="button" onClick={clear}>
        Clear
      </button>
    </>
  );
}

describe("inquiry list interaction", () => {
  it("deduplicates products and clears the list", async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    render(
      <InquiryListProvider>
        <Harness />
      </InquiryListProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByLabelText("count")).toHaveTextContent("1");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByLabelText("count")).toHaveTextContent("0");
  });
});
