import { css } from '@linaria/core';

// eslint-disable-next-line @typescript-eslint/no-unused-expressions
css`
  :global() {
    :root {
      --color-purple: #da68f5;
      --color-red: #f25f5b;
      --color-red-expiring: #ff436a;
      --color-yellow: #f4ce4a;
      --color-green: #00f6d2;
      --color-blue: #0bccf7;
      --color-dark-blue: #042548;
      --color-darkest-blue: #032e49;
      --color-white: #ffffff;
      --color-gray: #8196a4;
      //--color-white: white;
      --color-disabled: #8da1ad;
      --color-select-list: rgba(0, 0, 0, 0.8);
      --color-opasity-0-1: rgba(255, 255, 255, 0.1);

      /*
       * Spacing: fluid page gutter + stepped pool tokens.
       * Primary narrow breakpoint for pool spacing is 1080px (matches EmbeddedLayout column stack).
       * Legacy 913px remains for some grid/column switches only.
       */
      --page-padding-x: clamp(12px, 2.2vw + 8px, 20px);

      --pool-card-padding: 16px;
      --pool-block-padding: 12px;
      --pool-block-margin-bottom: 10px;
      --pool-grid-gap: 20px;
      --pool-embedded-layout-margin-top: 10px;
      --pool-right-panel-padding: 14px;
      --pool-summary-panel-padding: 12px;
      --pool-section-column-gap: 24px;
      --pool-line-margin-y: 20px;
      --pool-embedded-summary-margin-top: 16px;
      --pool-input-row-gap: 8px;
      --pool-embedded-action-row-gap: 8px;
      --pool-embedded-action-margin-top: 14px;
      --pool-embedded-trade-button-margin-top: 12px;
      --pool-select-wrapper-gap: 12px;
      --pool-select-wrapper-margin-y: 18px;
      --pool-trade-summary-row-pad: 14px;
      --pool-summary-title-margin-right: 30px;
      --pool-trade-summary-td-label-pad-right: 30px;
      --pool-summary-container-margin-bottom: 14px;
      --pool-summary-header-margin-bottom: 14px;
      --pool-empty-pool-padding-y: 24px;
      --pool-block-label-margin-bottom: 8px;
      --pool-hint-margin-top: 6px;
      --pool-embedded-exchange-margin-block-start: 4px;
      --pool-embedded-exchange-margin-block-end: 10px;

      @media (max-width: 1080px) {
        --pool-card-padding: 14px;
        --pool-block-padding: 10px;
        --pool-block-margin-bottom: 9px;
        --pool-grid-gap: 17px;
        --pool-embedded-layout-margin-top: 9px;
        --pool-right-panel-padding: 12px;
        --pool-summary-panel-padding: 10px;
        --pool-section-column-gap: 21px;
        --pool-line-margin-y: 17px;
        --pool-embedded-summary-margin-top: 17px;
        --pool-input-row-gap: 7px;
        --pool-embedded-action-row-gap: 7px;
        --pool-embedded-action-margin-top: 12px;
        --pool-embedded-trade-button-margin-top: 10px;
        --pool-select-wrapper-gap: 10px;
        --pool-select-wrapper-margin-y: 16px;
        --pool-trade-summary-row-pad: 12px;
        --pool-summary-title-margin-right: 26px;
        --pool-trade-summary-td-label-pad-right: 26px;
        --pool-summary-container-margin-bottom: 12px;
        --pool-summary-header-margin-bottom: 12px;
        --pool-empty-pool-padding-y: 21px;
        --pool-block-label-margin-bottom: 7px;
        --pool-hint-margin-top: 5px;
        --pool-embedded-exchange-margin-block-start: 3px;
        --pool-embedded-exchange-margin-block-end: 9px;
      }

      @media (max-width: 480px) {
        #btn_install {
       margin-left: 0 !important;
          margin-top: 10px;
        }
      }
    }

    * {
      box-sizing: border-box;
      outline: none;
    }
    html {
      margin: 0;
      padding: 0;
      height: 100%;
      width: 100%;
      overflow-x: hidden;
      overscroll-behavior: none;
    }

    body {
      margin: 0;
      padding: 0;
      height: 100%;
      width: 100%;
      min-width: 0;
      overflow-x: hidden;
      overscroll-behavior: none;
      touch-action: pan-y pinch-zoom;
      font-family: 'ProximaNova', 'SFProDisplay', sans-serif;
      font-weight: 600;
      font-size: 14px;
      color: white;
    }

    /* Same shell as Window (Utils.isWeb() || Utils.isMobile()); fills viewport behind TopNav */
    body.web,
    body.mobile {
      background-color: var(--color-dark-blue);
      min-height: 100vh;
    }

    html:has(body.web),
    html:has(body.mobile) {
      background-color: var(--color-dark-blue);
    }

    #root {
      display: block;
      height: 100%;
      min-height: 100%;
      width: 100%;
      max-width: 100%;
      overflow-x: hidden;
    }

    p {
      margin: 0;
    }

    h1,
    h2 {
      margin: 0;
    }

    ul,
    ol :not(.description) {
      margin: 0;
      padding: 0;
    }

    tr,
    th,
    table {
      border: none;
      border-spacing: 0;
      padding: 0;
      margin: 0;
      border-collapse: inherit;
    }
  }
  }
`;
