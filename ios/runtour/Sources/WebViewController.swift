import UIKit
import WebKit

/// RunTour is the bundled web build in a WKWebView — the iOS sibling of the
/// Android wrapper, serving assets through a custom scheme and relaying
/// nothing else yet (phase A; the bridge comes with phase B).
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {

    private var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: AppSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // Full-bleed map, like the Android app; the page's viewport-fit=cover
        // meta exposes the safe-area insets to its CSS.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        #if DEBUG
            if #available(iOS 16.4, *) {
                // Safari Web Inspector (needs a Mac, but costs nothing).
                webView.isInspectable = true
            }
        #endif
        view.addSubview(webView)

        let url = URL(string: "\(AppSchemeHandler.scheme)://app/index.html")!
        webView.load(URLRequest(url: url))
    }

    /// External links open in Safari; navigating the WebView away would
    /// reload the app and lose the session.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url, url.scheme != AppSchemeHandler.scheme {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /// target=_blank: no second WebView — Safari gets it.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme != AppSchemeHandler.scheme {
            UIApplication.shared.open(url)
        }
        return nil
    }
}
