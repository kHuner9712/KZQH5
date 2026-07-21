// Re-export from the refactored viewer module.
// The full implementation now lives in components/public/product-asset-viewer/.
// This file is kept for backward-compatible import paths.
export {
  ProductAssetViewer,
  productAssetTypeLabels,
  canPreviewProductAsset,
  formatProductAssetSize,
} from "./product-asset-viewer/ProductAssetViewer";
