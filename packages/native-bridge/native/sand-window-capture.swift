import Foundation
import Cocoa
import CoreGraphics

struct WindowInfo: Codable {
    let id: Int
    let owner: String
    let title: String
    let bounds: WindowBounds
}

struct WindowBounds: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct WindowListResult: Codable {
    let status: String
    let windows: [WindowInfo]
}

struct CaptureResult: Codable {
    let status: String
    let path: String
    let windowId: Int
}

func listWindows() {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let windowListInfo = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        print("{\"status\": \"error\", \"message\": \"Failed to retrieve window list\"}")
        exit(1)
    }

    var list: [WindowInfo] = []
    for info in windowListInfo {
        let id = info[kCGWindowNumber as String] as? Int ?? 0
        let owner = info[kCGWindowOwnerName as String] as? String ?? ""
        let title = info[kCGWindowName as String] as? String ?? ""
        let layer = info[kCGWindowLayer as String] as? Int ?? 0

        // Only include standard window layers (skip status bar items, docks, etc. if layer != 0)
        if layer == 0 {
            var bounds = WindowBounds(x: 0, y: 0, width: 0, height: 0)
            if let boundsDict = info[kCGWindowBounds as String] as? [String: Any] {
                bounds = WindowBounds(
                    x: boundsDict["X"] as? Double ?? 0,
                    y: boundsDict["Y"] as? Double ?? 0,
                    width: boundsDict["Width"] as? Double ?? 0,
                    height: boundsDict["Height"] as? Double ?? 0
                )
            }

            list.append(WindowInfo(
                id: id,
                owner: owner,
                title: title,
                bounds: bounds
            ))
        }
    }

    let result = WindowListResult(status: "ok", windows: list)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted]
    if let data = try? encoder.encode(result), let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

func captureWindow(windowId: Int, outputPath: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = ["-l\(windowId)", "-o", outputPath]

    do {
        try task.run()
        task.waitUntilExit()

        if task.terminationStatus == 0 {
            let result = CaptureResult(status: "ok", path: outputPath, windowId: windowId)
            let encoder = JSONEncoder()
            if let data = try? encoder.encode(result), let str = String(data: data, encoding: .utf8) {
                print(str)
            }
        } else {
            print("{\"status\": \"error\", \"message\": \"screencapture exited with code \(task.terminationStatus)\"}")
            exit(1)
        }
    } catch {
        print("{\"status\": \"error\", \"message\": \"Failed to run screencapture: \(error.localizedDescription)\"}")
        exit(1)
    }
}

func main() {
    let args = CommandLine.arguments
    if args.contains("--list") {
        listWindows()
        return
    }

    let outIndex = args.firstIndex(of: "--out") ?? args.firstIndex(of: "--output")
    if let windowIndex = args.firstIndex(of: "--window"), windowIndex + 1 < args.count,
       let outIdx = outIndex, outIdx + 1 < args.count {
        let winIdStr = args[windowIndex + 1]
        let outPath = NSString(string: args[outIdx + 1]).expandingTildeInPath
        if let winId = Int(winIdStr) {
            captureWindow(windowId: winId, outputPath: outPath)
            return
        }
    }

    print("{\"status\": \"error\", \"message\": \"Usage: sand-window-capture --list OR --window <id> --out <path>\"}")
    exit(1)
}

main()
