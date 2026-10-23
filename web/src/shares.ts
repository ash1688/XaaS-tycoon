// Shares and stakes, as the Finance page shows them.

/** A share of the company, 0–1, as a percentage to one decimal place: "84.4%". */
export const formatShare = (share: number) => `${(Math.round(share * 1000) / 10).toLocaleString("en-GB")}%`;

/** A share price: to the penny, or to a tenth of a penny under £1, since with many shares it can be very small. */
export const formatSharePrice = (price: number) =>
  `£${price.toLocaleString("en-GB", { minimumFractionDigits: price < 1 ? 3 : 2, maximumFractionDigits: price < 1 ? 3 : 2 })}`;
