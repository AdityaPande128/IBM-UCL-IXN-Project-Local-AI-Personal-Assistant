import Foundation
import Cocoa

let args = ProcessInfo.processInfo.arguments
guard args.count > 1, let b = Float(args[1]) else { exit(1) }

let displayID = CGMainDisplayID()
let displayServicesStr = "DisplayServicesSetBrightness"
let displayServicesSetBrightness = dlsym(dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_LAZY), displayServicesStr)
typealias DisplayServicesSetBrightnessType = @convention(c) (CGDirectDisplayID, Float) -> Int32
let setBrightness = unsafeBitCast(displayServicesSetBrightness, to: DisplayServicesSetBrightnessType.self)
let _ = setBrightness(displayID, b)
