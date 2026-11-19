#import <Foundation/Foundation.h>
#import <Vision/Vision.h>

int main(void) {
  @autoreleasepool {
    NSData *image = NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.recognitionLanguages = @[@"zh-Hans", @"zh-Hant", @"en-US"];
    request.usesLanguageCorrection = NO;
    request.minimumTextHeight = 0.008;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithData:image options:@{}];
    if (![handler performRequests:@[request] error:nil]) return 1;

    NSMutableArray *lines = [NSMutableArray array];
    for (VNRecognizedTextObservation *observation in request.results) {
      VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
      if (!candidate.string.length) continue;
      CGRect box = observation.boundingBox;
      // Vision's origin is bottom-left. Device gestures use the top-left of the same image.
      [lines addObject:@{@"text": candidate.string, @"confidence": @(candidate.confidence),
                         @"x": @(CGRectGetMidX(box)), @"y": @(1.0 - CGRectGetMidY(box))}];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:lines options:0 error:nil];
    if (!json) return 1;
    [NSFileHandle.fileHandleWithStandardOutput writeData:json];
  }
  return 0;
}
