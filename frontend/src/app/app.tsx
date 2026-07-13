import React, { useEffect, useRef } from 'react';
import { css } from '@linaria/core';

import { actions as sharedActions, selectors as sharedSelectors } from '@app/shared/store';
import 'react-toastify/dist/ReactToastify.css';

import {
  Navigate, useLocation, useNavigate, useRoutes,
} from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';

import { ToastContainer } from 'react-toastify';
import { Scrollbars } from 'react-custom-scrollbars';

import './styles';
import {
  PairsList,
  PairDetail,
  LiquidityPosition,
  AssetsList,
  AssetDetail,
  NetworkCharts,
  ExplorerLayout,
  Countdown,
  Supply,
  BANS,
  BridgeTracker,
  Mining,
  BeamExplorer,
  AtomicSwaps,
  AssetSwaps,
  Dapps,
  Privacy,
  Footer,
  AssetColorsProvider,
} from '@app/containers/Screener';
import { DaoLayout, DaoOverview, DaoTreasury, DaoRevenue, DaoGovernance, DaoProposal } from '@app/containers/Screener';
import { ROUTES } from '@app/shared/constants';
import { Loader, TopNav } from '@app/shared/components';
import ErrorBoundary from '@app/shared/components/ErrorBoundary';
import BeamDappConnector from '@core/BeamDappConnector.js';
import { selectIsLoaded } from '@app/shared/store/selectors';

const trackStyle = css`
  z-index: 999;
  border-radius: 3px;
  background-color: rgba(255, 255, 255, 0.2);
`;

// react-custom-scrollbars ships no types; just the instance methods we call.
interface ScrollbarsHandle {
  scrollToTop(): void;
  update(): void;
}

const routes = [
  { path: '*', element: <Navigate to={ROUTES.NAV.DEX} replace /> },
  { path: ROUTES.NAV.DEX, element: <PairsList /> },
  { path: ROUTES.NAV.LIQUIDITY, element: <LiquidityPosition /> },
  { path: ROUTES.NAV.PAIR_DETAIL, element: <PairDetail /> },
  { path: ROUTES.NAV.ASSETS, element: <AssetsList /> },
  { path: ROUTES.NAV.ASSET_INFO, element: <AssetDetail /> },
  { path: ROUTES.NAV.ATOMIC_SWAPS, element: <AtomicSwaps /> },
  { path: ROUTES.NAV.ASSET_SWAPS, element: <AssetSwaps /> },
  { path: ROUTES.NAV.DAPPS, element: <Dapps /> },
  { path: ROUTES.NAV.PRIVACY, element: <Privacy /> },
  {
    path: ROUTES.NAV.EXPLORER,
    element: <ExplorerLayout />,
    children: [
      { index: true, element: <Navigate to={ROUTES.NAV.EXPLORER_CHARTS} replace /> },
      { path: 'charts',    element: <NetworkCharts /> },
      { path: 'beam',      element: <BeamExplorer /> },
      { path: 'bans',      element: <BANS /> },
      { path: 'countdown', element: <Countdown /> },
      { path: 'supply',    element: <Supply /> },
      { path: 'bridge',    element: <BridgeTracker /> },
      { path: 'mining',   element: <Mining /> },
      {
        path: 'dao',
        element: <DaoLayout />,
        children: [
          { index: true, element: <DaoOverview /> },
          { path: 'treasury', element: <DaoTreasury /> },
          { path: 'revenue', element: <DaoRevenue /> },
          { path: 'governance', element: <DaoGovernance /> },
          { path: 'governance/proposal/:id', element: <DaoProposal /> },
        ],
      },
    ],
  },
];

const App = () => {
  const dispatch = useDispatch();
  const content = useRoutes(routes);
  const navigate = useNavigate();
  const navigateURL = useSelector(sharedSelectors.selectRouterLink());
  const isLoaded = useSelector(selectIsLoaded());
  const isWeb = BeamDappConnector.isWeb();
  const { pathname } = useLocation();
  const scrollbarsRef = useRef<ScrollbarsHandle | null>(null);
  const scrollContentRef = useRef<HTMLDivElement | null>(null);

  // Land every route at the top. The Scrollbars view keeps its scrollTop while
  // the route content underneath it swaps, so a scrolled page otherwise leaks
  // a (clamped) scroll offset into the next page — which entry path you came
  // from decided whether a page arrived scrolled and with a scrollbar.
  useEffect(() => {
    scrollbarsRef.current?.scrollToTop();
  }, [pathname]);

  // Scrollbars re-measures only on its own re-render, window resize, or a
  // scroll event. Route data loading in (the page growing several-fold) is
  // none of those, so the track visibility and thumb size go stale until the
  // user happens to scroll. Watch the content's height instead.
  // ResizeObserver is Chrome 64+, available in the wallet's Chrome 83.
  useEffect(() => {
    if (typeof ResizeObserver !== 'function' || !scrollContentRef.current) return undefined;
    const observer = new ResizeObserver(() => scrollbarsRef.current?.update());
    observer.observe(scrollContentRef.current);
    return () => observer.disconnect();
  }, [isLoaded]);

  useEffect(() => {
    // Activates the `body.web` / `body.mobile` rule in styles.ts so the page
    // shell gets the dark-blue background outside the desktop wallet, which
    // would otherwise show through as plain white.
    const cls = BeamDappConnector.isMobile() ? 'mobile' : isWeb ? 'web' : 'desktop';
    document.body.classList.add(cls);
    return () => document.body.classList.remove(cls);
  }, [isWeb]);

  useEffect(() => {
    if (navigateURL) {
      navigate(navigateURL);
      dispatch(sharedActions.navigate(''));
    }
  }, [navigateURL, dispatch, navigate]);

  return (
    <>
      {isLoaded ? (
        <Scrollbars
          ref={scrollbarsRef}
          style={{ width: '100%', height: '100%' }}
          hideTracksWhenNotNeeded
          renderThumbVertical={(props) => <div {...props} className={trackStyle} />}
          renderView={({ style, ...viewProps }) => (
            <div
              {...viewProps}
              style={{
                ...style,
                overflowX: 'hidden',
                overflowY: 'scroll',
                WebkitOverflowScrolling: 'touch',
                overscrollBehavior: 'none',
              }}
            />
          )}
        >
          {/* Single child observed by the ResizeObserver above: its height is
              the full content height, so any page growing/shrinking re-syncs
              the scrollbar. */}
          <div ref={scrollContentRef}>
            <TopNav />
            <AssetColorsProvider>
              <ErrorBoundary>{content}</ErrorBoundary>
            </AssetColorsProvider>
            <Footer />
          </div>
          <ToastContainer
            position="bottom-right"
            autoClose={3000}
            hideProgressBar
            newestOnTop={false}
            closeOnClick
            closeButton={false}
            rtl={false}
            pauseOnFocusLoss={false}
            draggable={false}
            pauseOnHover={false}
            icon={false}
            toastStyle={{
              textAlign: 'center',
              background: '#22536C',
              color: 'white',
              width: '90%',
              margin: '0 auto 36px',
              borderRadius: '10px',
            }}
          />
        </Scrollbars>
      ) : <Loader />}
    </>
  );
};

export default App;
