import Foundation
import Vision
import Cocoa

struct TextBlock: Codable {
    let text: String
    let confidence: Float
    let box: BoundingBox
}

struct BoundingBox: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct VisionResult: Codable {
    let status: String
    let image: String
    let text: String
    let blocks: [TextBlock]
}

func main() {
    let args = CommandLine.arguments
    if args.count < 2 {
        let errJson = "{\"status\": \"error\", \"message\": \"Usage: sand-vision <image-path>\"}"
        print(errJson)
        exit(1)
    }

    let imagePath = args[1]
    let expandedPath = NSString(string: imagePath).expandingTildeInPath
    let fileUrl = URL(fileURLWithPath: expandedPath)

    guard FileManager.default.fileExists(atPath: fileUrl.path) else {
        let errJson = "{\"status\": \"error\", \"message\": \"File not found: \(fileUrl.path)\"}"
        print(errJson)
        exit(1)
    }

    guard let image = NSImage(contentsOf: fileUrl),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        let errJson = "{\"status\": \"error\", \"message\": \"Failed to decode image data\"}"
        print(errJson)
        exit(1)
    }

    var blocks: [TextBlock] = []
    var fullTextLines: [String] = []

    let request = VNRecognizeTextRequest { (request, error) in
        guard let observations = request.results as? [VNRecognizedTextObservation], error == nil else {
            return
        }

        for observation in observations {
            guard let topCandidate = observation.topCandidates(1).first else { continue }
            let text = topCandidate.string
            let confidence = topCandidate.confidence
            let box = observation.boundingBox

            fullTextLines.append(text)
            blocks.append(TextBlock(
                text: text,
                confidence: confidence,
                box: BoundingBox(
                    x: Double(box.origin.x),
                    y: Double(box.origin.y),
                    width: Double(box.size.width),
                    height: Double(box.size.height)
                )
            ))
        }
    }

    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
        let result = VisionResult(
            status: "ok",
            image: fileUrl.path,
            text: fullTextLines.joined(separator: "\n"),
            blocks: blocks
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted]
        let jsonData = try encoder.encode(result)
        if let jsonString = String(data: jsonData, encoding: .utf8) {
            print(jsonString)
        }
    } catch {
        let errJson = "{\"status\": \"error\", \"message\": \"Vision request failed: \(error.localizedDescription)\"}"
        print(errJson)
        exit(1)
    }
}

main()
