import WebKit

/// Serves the bundled web build (Resources/www) on runtour://app/… — the
/// analog of the Android wrapper's shouldInterceptRequest. file:// would
/// refuse Vite's module scripts and crossorigin stylesheets, so the app
/// lives on a scheme of its own.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {

    static let scheme = "runtour"

    /// Tasks WebKit has stopped; replying to one raises an exception.
    private var stopped = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            reply(urlSchemeTask, status: 400, mime: "text/plain", data: Data())
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        // The service worker's own fetches bypass this handler, so a
        // registered worker would strand the app against a host that does
        // not exist. Refusing sw.js keeps us in charge.
        if path == "/sw.js" || path.contains("..") {
            reply(urlSchemeTask, status: 404, mime: "text/plain", data: Data())
            return
        }

        guard let base = Bundle.main.resourceURL?.appendingPathComponent("www", isDirectory: true)
        else {
            reply(urlSchemeTask, status: 404, mime: "text/plain", data: Data())
            return
        }
        let file = base.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(base.standardizedFileURL.path),
            let data = try? Data(contentsOf: file)
        else {
            reply(urlSchemeTask, status: 404, mime: "text/plain", data: Data())
            return
        }
        reply(urlSchemeTask, status: 200, mime: Self.mime(for: path), data: data)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(urlSchemeTask))
    }

    private func reply(_ task: WKURLSchemeTask, status: Int, mime: String, data: Data) {
        let id = ObjectIdentifier(task)
        if stopped.contains(id) {
            stopped.remove(id)
            return
        }
        let response = HTTPURLResponse(
            url: task.request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mime,
                "Content-Length": String(data.count),
            ]
        )!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private static func mime(for path: String) -> String {
        if path.hasSuffix(".html") { return "text/html" }
        if path.hasSuffix(".js") { return "text/javascript" }
        if path.hasSuffix(".css") { return "text/css" }
        if path.hasSuffix(".json") || path.hasSuffix(".webmanifest") { return "application/json" }
        if path.hasSuffix(".svg") { return "image/svg+xml" }
        if path.hasSuffix(".png") { return "image/png" }
        if path.hasSuffix(".jpg") || path.hasSuffix(".jpeg") { return "image/jpeg" }
        if path.hasSuffix(".woff2") { return "font/woff2" }
        if path.hasSuffix(".wav") { return "audio/wav" }
        return "application/octet-stream"
    }
}
