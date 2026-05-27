import React, { useEffect } from 'react';
import { css } from '@linaria/core';

import { actions as sharedActions, selectors as sharedSelectors } from '@app/shared/store';
import 'react-toastify/dist/ReactToastify.css';

import { Navigate, useNavigate, useRoutes } from 'react-router-dom';
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
  Health,
  BANS,
  BridgeTracker,
  BeamExplorer,
  Privacy,
  Footer,
} from '@app/containers/Screener';
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

const routes = [
  { path: '*', element: <Navigate to={ROUTES.NAV.PAIRS} replace /> },
  { path: ROUTES.NAV.PAIRS, element: <PairsList /> },
  { path: ROUTES.NAV.LIQUIDITY, element: <LiquidityPosition /> },
  { path: ROUTES.NAV.PAIR_DETAIL, element: <PairDetail /> },
  { path: ROUTES.NAV.ASSETS, element: <AssetsList /> },
  { path: ROUTES.NAV.ASSET_INFO, element: <AssetDetail /> },
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
      { path: 'health',    element: <Health /> },
      { path: 'supply',    element: <Supply /> },
      { path: 'bridge',    element: <BridgeTracker /> },
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
          <TopNav />
          <ErrorBoundary>{content}</ErrorBoundary>
          <Footer />
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
