import setup, { hideLoadingAnimation, showErrorScreen, showLoadingAnimation } from "@inkandswitch/patchwork";

showLoadingAnimation();

// A stock Patchwork site with only the base modules of @inkandswitch/patchwork-pkg-base.
window.patchwork = await setup({
  packageListURL: "/modules.json",
  accountKey: "reproAccountUrl",
  frameToolId: "threepane",
}).catch((error: unknown) => {
  showErrorScreen(error);
  throw error;
});

hideLoadingAnimation();
