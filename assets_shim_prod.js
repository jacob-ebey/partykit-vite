import manifestJSON from "__STATIC_CONTENT_MANIFEST";

export default {
  singlePageApp: true,
  assets: JSON.parse(manifestJSON),
};
